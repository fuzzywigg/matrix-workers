/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #318 / tip past #318+#319 —
 * residual *presence + receipts + typing* soft→*concurrent-race* fourth-wave
 * binds unsaturated by:
 *   #301 first wave (other-user / busy substring / User not found / typing
 *        other+leave+Missing / receipt Invalid type — never case/whitespace
 *        string presence under soft∥success residual),
 *   #305 second wave (exact busy / read_markers / multi soft quads),
 *   #318 third wave (undefined/null/false/0 / typing non-boolean /
 *        invite+ban membership — never ONLINE/Online/idle/invisible/
 *        empty/whitespace string pins under soft residual PA; never typing
 *        knock membership; never receipt invite/ban/knock membership soft;
 *        never truncated-JSON badJson ∥ ok under residual soft files).
 *
 * Gap table (why leftover after #318):
 *   case/whitespace/empty/idle/invisible presence exact strings ∥ ok
 *   presence: true exact ∥ ok
 *   truncated JSON M_BAD_JSON ∥ valid PUT under race
 *   typing knock membership Not a member ∥ join ok
 *   receipt invite + ban + knock membership Not a member ∥ m.read ok
 *   cross-domain: ONLINE + typing knock + receipt invite ∥ oks
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
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const NOW = 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer test-token' };

const NOT_A_MEMBER = {
  errcode: 'M_FORBIDDEN',
  error: 'Not a member of this room',
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
// Case / whitespace / empty / idle / invisible presence exact softs ∥ ok
// ---------------------------------------------------------------------------

describe('presence fourth-wave concurrent case/whitespace string soft after #318', () => {
  const cases: Array<{ label: string; body: unknown; error: string }> = [
    {
      label: 'empty-string',
      body: { presence: '' },
      error: 'Invalid presence state: . Must be one of: online, offline, unavailable',
    },
    {
      label: 'whitespace',
      body: { presence: ' ' },
      error: 'Invalid presence state:  . Must be one of: online, offline, unavailable',
    },
    {
      label: 'ONLINE-upper',
      body: { presence: 'ONLINE' },
      error: 'Invalid presence state: ONLINE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Online-mixed',
      body: { presence: 'Online' },
      error: 'Invalid presence state: Online. Must be one of: online, offline, unavailable',
    },
    {
      label: 'leading-space',
      body: { presence: ' online' },
      error: 'Invalid presence state:  online. Must be one of: online, offline, unavailable',
    },
    {
      label: 'idle',
      body: { presence: 'idle' },
      error: 'Invalid presence state: idle. Must be one of: online, offline, unavailable',
    },
    {
      label: 'invisible',
      body: { presence: 'invisible' },
      error: 'Invalid presence state: invisible. Must be one of: online, offline, unavailable',
    },
    {
      label: 'boolean-true',
      body: { presence: true },
      error: 'Invalid presence state: true. Must be one of: online, offline, unavailable',
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

  it('ONLINE ∥ Online ∥ idle ∥ invisible ∥ online under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'ONLINE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'Online' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'idle' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'invisible' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
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
        'Invalid presence state: ONLINE. Must be one of: online, offline, unavailable',
        'Invalid presence state: Online. Must be one of: online, offline, unavailable',
        'Invalid presence state: idle. Must be one of: online, offline, unavailable',
        'Invalid presence state: invisible. Must be one of: online, offline, unavailable',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Truncated JSON badJson ∥ valid PUT — residual soft concurrent
// ---------------------------------------------------------------------------

describe('presence fourth-wave concurrent truncated badJson soft after #318', () => {
  it('truncated JSON ∥ online under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{"presence":"onlin',
        },
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'offline' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(softBody(results, 200).body).toEqual({});
  });

  it('empty body ∥ array-root ∥ online under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '',
        },
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', ['online']),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'unavailable' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    const errors = results.filter((r) => r.status === 400).map((r) => r.body.errcode).sort();
    expect(errors).toEqual(['M_BAD_JSON', 'M_INVALID_PARAM'].sort());
  });

  for (let i = 0; i < 6; i++) {
    it(`truncated badJson flood-${i} ∥ ok`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...AUTH },
            body: `{"presence":"offlin`,
          },
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: i % 2 === 0 ? 'online' : 'offline' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.errcode).toBe('M_BAD_JSON');
    });
  }
});

// ---------------------------------------------------------------------------
// Typing knock membership soft ∥ join — never under #318 invite/ban/leave
// ---------------------------------------------------------------------------

describe('typing fourth-wave concurrent knock membership soft after #318', () => {
  it('knock membership Not a member ∥ join ok', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'knock' },
          { room_id: ROOM2, user_id: USER, membership: 'join' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true }), env),
      typingReq(typingPath(USER_ENC, ROOM2_ENC), jsonInit('PUT', { typing: true, timeout: 1000 }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    expect(softBody(results, 200).body).toEqual({});
  });

  it('knock + invite + ban ∥ join start under race', async () => {
    const roomDO = createRoomDOStub();
    const knockRoom = '!knock:example.com';
    const inviteRoom = '!inv:example.com';
    const banRoom = '!ban:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: knockRoom, user_id: USER, membership: 'knock' },
          { room_id: inviteRoom, user_id: USER, membership: 'invite' },
          { room_id: banRoom, user_id: USER, membership: 'ban' },
          { room_id: ROOM, user_id: USER, membership: 'join' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC, encodeURIComponent(knockRoom)),
        jsonInit('PUT', { typing: true }),
        env
      ),
      typingReq(
        typingPath(USER_ENC, encodeURIComponent(inviteRoom)),
        jsonInit('PUT', { typing: false }),
        env
      ),
      typingReq(
        typingPath(USER_ENC, encodeURIComponent(banRoom)),
        jsonInit('PUT', { typing: true }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 500 }), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
    expect(
      results.filter((r) => r.status === 403).every((r) => r.body.error === NOT_A_MEMBER.error)
    ).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`typing knock soft flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!k${i}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: softRoom, user_id: USER, membership: 'knock' },
            { room_id: ROOM, user_id: USER, membership: 'join' },
          ],
        }),
      });
      const results = await Promise.all([
        typingReq(
          typingPath(USER_ENC, encodeURIComponent(softRoom)),
          jsonInit('PUT', { typing: true }),
          env
        ),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    });
  }
});

// ---------------------------------------------------------------------------
// Receipt invite/ban/knock membership soft ∥ m.read ok
// ---------------------------------------------------------------------------

describe('receipts fourth-wave concurrent invite/ban/knock membership soft after #318', () => {
  for (const membership of ['invite', 'ban', 'knock'] as const) {
    it(`receipt ${membership} membership Not a member ∥ m.read ok`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!r-${membership}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: softRoom, user_id: USER, membership },
            { room_id: ROOM, user_id: USER, membership: 'join' },
          ],
        }),
      });
      const results = await Promise.all([
        receiptsReq(
          receiptPath('m.read', '$e1', encodeURIComponent(softRoom)),
          jsonInit('POST', {}),
          env
        ),
        receiptsReq(receiptPath('m.read', '$e-ok'), jsonInit('POST', {}), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
      expect(softBody(results, 200).body).toEqual({});
    });
  }

  it('invite + ban + knock ∥ m.read + m.read.private under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: '!ri:example.com', user_id: USER, membership: 'invite' },
          { room_id: '!rb:example.com', user_id: USER, membership: 'ban' },
          { room_id: '!rk:example.com', user_id: USER, membership: 'knock' },
          { room_id: ROOM, user_id: USER, membership: 'join' },
        ],
      }),
    });
    const results = await Promise.all([
      receiptsReq(
        receiptPath('m.read', '$a', encodeURIComponent('!ri:example.com')),
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(
        receiptPath('m.read', '$b', encodeURIComponent('!rb:example.com')),
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(
        receiptPath('m.read', '$c', encodeURIComponent('!rk:example.com')),
        jsonInit('POST', {}),
        env
      ),
      receiptsReq(receiptPath('m.read', '$ok1'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.read.private', '$ok2'), jsonInit('POST', {}), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
    expect(
      results.filter((r) => r.status === 403).every((r) => r.body.error === NOT_A_MEMBER.error)
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-domain fourth-wave soft isolation
// ---------------------------------------------------------------------------

describe('presence/receipts/typing fourth-wave cross-domain soft isolation after #318', () => {
  it('ONLINE + typing knock + receipt invite ∥ three successes', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'knock' },
          { room_id: '!ri:example.com', user_id: USER, membership: 'invite' },
        ],
      }),
    });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'ONLINE' }),
        env
      ),
      typingReq(typingPath(USER_ENC, ROOM2_ENC), jsonInit('PUT', { typing: true }), env),
      receiptsReq(
        receiptPath('m.read', '$x', encodeURIComponent('!ri:example.com')),
        jsonInit('POST', {}),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'online' }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
      receiptsReq(receiptPath('m.read', '$ok'), jsonInit('POST', {}), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    expect(softBody(results, 400).body.error).toBe(
      'Invalid presence state: ONLINE. Must be one of: online, offline, unavailable'
    );
    expect(
      results.filter((r) => r.status === 403).every((r) => r.body.error === NOT_A_MEMBER.error)
    ).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain fourth-wave soft isolation flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!s${i}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            { room_id: softRoom, user_id: USER, membership: i % 2 === 0 ? 'knock' : 'invite' },
          ],
        }),
      });
      const badPresence = i % 3 === 0 ? 'ONLINE' : i % 3 === 1 ? 'idle' : 'invisible';
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: badPresence }),
          env
        ),
        typingReq(
          typingPath(USER_ENC, encodeURIComponent(softRoom)),
          jsonInit('PUT', { typing: true }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'unavailable' }),
          env
        ),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.status === 400)).toHaveLength(1);
      expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    });
  }
});
