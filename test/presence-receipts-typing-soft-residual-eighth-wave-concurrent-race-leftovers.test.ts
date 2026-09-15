/**
 * TOKENMAXX HEAVY tip-relaunch deepen after tip ~9065fa5 / merged #342 —
 * residual *presence + receipts + typing* soft→*concurrent-race* eighth-wave
 * binds unsaturated by:
 *   #301/#305/#318/#327/#334 waves + open sixth-wave #341 + open seventh-wave #348 —
 *   never OnliNE/oFfLine/UnaVailable / \\nunavailable / unavailable-trailing-space /
 *     away/dnd/hidden/active/xa/chat/Gone/SLEEPING decoys under soft residual PA,
 *   never typing non-boolean []/"false"/0/2/"TRUE" Missing typing ∥ boolean ok,
 *   never receipt case-mutated M.READ.PRIVATE/m.FULLY_READ/M.Fully_Read/
 *     m.Read.private/M.read/m.READ (distinct from #341/#348 case pins).
 *
 * Gap table (why leftover after #334 + complementary to #341/#348):
 *   OnliNE/oFfLine/UnaVailable + decoy exact Invalid state ∥ ok
 *   typing residual non-boolean Missing typing ∥ ok
 *   receipt residual case-mutated Invalid type matrix ∥ m.read ok
 *   cross-domain: OnliNE + typing [] + M.READ.PRIVATE ∥ oks
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
const SERVER = 'example.com';
const USER_ENC = encodeURIComponent(USER);
const ROOM_ENC = encodeURIComponent(ROOM);
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
// OnliNE / oFfLine / UnaVailable / decoy softs ∥ ok
// ---------------------------------------------------------------------------

describe('presence eighth-wave concurrent residual case soft after #342', () => {
  const cases: Array<{ label: string; body: unknown; error: string }> = [
    {
      label: 'OnliNE-mixed',
      body: { presence: 'OnliNE' },
      error: 'Invalid presence state: OnliNE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'oFfLine-mixed',
      body: { presence: 'oFfLine' },
      error: 'Invalid presence state: oFfLine. Must be one of: online, offline, unavailable',
    },
    {
      label: 'UnaVailable-mixed',
      body: { presence: 'UnaVailable' },
      error: 'Invalid presence state: UnaVailable. Must be one of: online, offline, unavailable',
    },
    {
      label: 'leading-newline-unavailable',
      body: { presence: '\nunavailable' },
      error: 'Invalid presence state: \nunavailable. Must be one of: online, offline, unavailable',
    },
    {
      label: 'trailing-space-unavailable',
      body: { presence: 'unavailable ' },
      error: 'Invalid presence state: unavailable . Must be one of: online, offline, unavailable',
    },
    {
      label: 'away-lower',
      body: { presence: 'away' },
      error: 'Invalid presence state: away. Must be one of: online, offline, unavailable',
    },
    {
      label: 'dnd-lower',
      body: { presence: 'dnd' },
      error: 'Invalid presence state: dnd. Must be one of: online, offline, unavailable',
    },
    {
      label: 'hidden-lower',
      body: { presence: 'hidden' },
      error: 'Invalid presence state: hidden. Must be one of: online, offline, unavailable',
    },
    {
      label: 'active-lower',
      body: { presence: 'active' },
      error: 'Invalid presence state: active. Must be one of: online, offline, unavailable',
    },
    {
      label: 'xa-lower',
      body: { presence: 'xa' },
      error: 'Invalid presence state: xa. Must be one of: online, offline, unavailable',
    },
    {
      label: 'chat-lower',
      body: { presence: 'chat' },
      error: 'Invalid presence state: chat. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Gone-title',
      body: { presence: 'Gone' },
      error: 'Invalid presence state: Gone. Must be one of: online, offline, unavailable',
    },
    {
      label: 'SLEEPING-upper',
      body: { presence: 'SLEEPING' },
      error: 'Invalid presence state: SLEEPING. Must be one of: online, offline, unavailable',
    },
  ];

  for (const c of cases) {
    it(`${c.label} exact ∥ online success`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', c.body),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'online', status_msg: 'ok' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: c.error,
      });
      expect(softBody(results, 200).body).toEqual({});
    });
  }

  it('OnliNE ∥ oFfLine ∥ away ∥ SLEEPING ∥ offline under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OnliNE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'oFfLine' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'away' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'SLEEPING' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'offline' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Invalid presence state: OnliNE. Must be one of: online, offline, unavailable',
        'Invalid presence state: oFfLine. Must be one of: online, offline, unavailable',
        'Invalid presence state: away. Must be one of: online, offline, unavailable',
        'Invalid presence state: SLEEPING. Must be one of: online, offline, unavailable',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Typing residual non-boolean [] / "false" / 0 / 2 / "TRUE" Missing typing ∥ ok
// ---------------------------------------------------------------------------

describe('typing eighth-wave concurrent residual non-boolean soft after #342', () => {
  const cases: Array<{ label: string; body: unknown }> = [
    { label: 'typing-array', body: { typing: [] } },
    { label: 'typing-false-string', body: { typing: 'false' } },
    { label: 'typing-zero', body: { typing: 0 } },
    { label: 'typing-two', body: { typing: 2 } },
    { label: 'typing-TRUE-string', body: { typing: 'TRUE' } },
  ];

  for (const c of cases) {
    it(`${c.label} Missing typing ∥ boolean true under race`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        typingReq(typingPath(USER_ENC), jsonInit('PUT', c.body), env),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 1000 }), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: typing',
      });
      expect(softBody(results, 200).body).toEqual({});
    });
  }

  it('typing [] ∥ "false" ∥ 0 ∥ two oks under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: [] }), env),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: 'false' }), env),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: 0 }), env),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true }), env),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(
      results
        .filter((r) => r.status === 400)
        .every((r) => r.body.error === 'Missing required parameter: typing')
    ).toBe(true);
  });

  for (let i = 0; i < 3; i++) {
    it(`typing residual non-boolean Missing flood-${i} ∥ ok`, async () => {
      const env = createEnv();
      const soft = ([{ typing: [] }, { typing: 'TRUE' }, { typing: 2 }] as const)[i % 3];
      const results = await Promise.all([
        typingReq(typingPath(USER_ENC), jsonInit('PUT', soft), env),
        typingReq(
          typingPath(USER_ENC),
          jsonInit('PUT', { typing: i % 2 === 0, timeout: 500 }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.error).toBe('Missing required parameter: typing');
    });
  }
});

// ---------------------------------------------------------------------------
// Receipt residual case-mutated Invalid type ∥ m.read ok
// ---------------------------------------------------------------------------

describe('receipts eighth-wave concurrent residual case-mutated Invalid type after #342', () => {
  const receiptPath = (type: string, eventId: string, roomEnc = ROOM_ENC) =>
    `/_matrix/client/v3/rooms/${roomEnc}/receipt/${encodeURIComponent(type)}/${encodeURIComponent(eventId)}`;

  for (const badType of [
    'M.READ.PRIVATE',
    'm.FULLY_READ',
    'M.Fully_Read',
    'm.Read.private',
    'M.read',
    'm.READ',
  ] as const) {
    it(`exact Invalid receipt type '${badType}' ∥ m.read under race`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        receiptsReq(receiptPath(badType, '$bad:example.com'), jsonInit('POST', {}), env),
        receiptsReq(receiptPath('m.read', '$ok:example.com'), jsonInit('POST', {}), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: `Invalid receipt type: ${badType}`,
      });
      expect(softBody(results, 200).body).toEqual({});
    });
  }

  it('M.READ.PRIVATE ∥ m.FULLY_READ ∥ m.READ ∥ two m.read under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      receiptsReq(receiptPath('M.READ.PRIVATE', '$a:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.FULLY_READ', '$b:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.READ', '$c:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.read', '$ok1:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.read.private', '$ok2:example.com'), jsonInit('POST', {}), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Invalid receipt type: M.READ.PRIVATE',
        'Invalid receipt type: m.FULLY_READ',
        'Invalid receipt type: m.READ',
      ].sort()
    );
  });

  for (let i = 0; i < 3; i++) {
    it(`receipt residual case soft flood-${i}`, async () => {
      const env = createEnv();
      const badType = (['M.Fully_Read', 'm.Read.private', 'M.read'] as const)[i % 3];
      const results = await Promise.all([
        receiptsReq(receiptPath(badType, `$s-${i}:example.com`), jsonInit('POST', {}), env),
        receiptsReq(receiptPath('m.read', `$ok-${i}:example.com`), jsonInit('POST', {}), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.error).toBe(`Invalid receipt type: ${badType}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-domain: OnliNE + typing [] + M.READ.PRIVATE ∥ oks
// ---------------------------------------------------------------------------

describe('presence/receipts/typing eighth-wave cross-domain soft isolation after #342', () => {
  const receiptPath = (type: string, eventId: string) =>
    `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/${encodeURIComponent(type)}/${encodeURIComponent(eventId)}`;

  it('OnliNE + typing [] + M.READ.PRIVATE ∥ three successes', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OnliNE' }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: [] }), env),
      receiptsReq(receiptPath('M.READ.PRIVATE', '$x:example.com'), jsonInit('POST', {}), env),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'offline' }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
      receiptsReq(receiptPath('m.read', '$ok:example.com'), jsonInit('POST', {}), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(
      results
        .filter((r) => r.status === 400)
        .map((r) => r.body.error)
        .sort()
    ).toEqual(
      [
        'Invalid presence state: OnliNE. Must be one of: online, offline, unavailable',
        'Missing required parameter: typing',
        'Invalid receipt type: M.READ.PRIVATE',
      ].sort()
    );
  });

  for (let i = 0; i < 3; i++) {
    it(`eighth-wave cross-domain soft flood-${i}`, async () => {
      const env = createEnv();
      const badPresence = (['away', 'dnd', 'SLEEPING'] as const)[i % 3];
      const badTyping = ([{ typing: 0 }, { typing: 'false' }, { typing: 'TRUE' }] as const)[i % 3];
      const badReceipt = (['m.FULLY_READ', 'M.read', 'm.READ'] as const)[i % 3];
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: badPresence }),
          env
        ),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', badTyping), env),
        receiptsReq(receiptPath(badReceipt, `$x-${i}:example.com`), jsonInit('POST', {}), env),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'unavailable' }),
          env
        ),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 200 }), env),
        receiptsReq(receiptPath('m.read', `$ok-${i}:example.com`), jsonInit('POST', {}), env),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    });
  }
});
