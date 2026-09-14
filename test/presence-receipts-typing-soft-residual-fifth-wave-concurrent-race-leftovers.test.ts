/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #327 / tip past #327+#328 —
 * residual *presence + receipts + typing* soft→*concurrent-race* fifth-wave
 * binds unsaturated by:
 *   #301 first wave (other-user / busy substring / User not found / typing
 *        other+leave+Missing / receipt Invalid type),
 *   #305 second wave (exact busy / read_markers leave+badJson / multi softs),
 *   #318 third wave (undefined/null/false/0 / typing non-boolean /
 *        invite+ban membership),
 *   #327 fourth wave (ONLINE/Online/idle/invisible/empty/whitespace/true /
 *        presence truncated badJson / typing knock / receipt invite+ban+knock —
 *        never OFFLINE/Offline/UNAVAILABLE/Unavailable/oNline case pins of
 *        *valid* states under soft residual PA; never tab/newline whitespace;
 *        never typing truncated-JSON badJson ∥ ok; never read_markers
 *        invite/ban/knock membership soft ∥ joined markers).
 *
 * Gap table (why leftover after #327):
 *   OFFLINE/Offline/UNAVAILABLE/Unavailable/oNline exact Invalid state ∥ ok
 *   tab/newline whitespace presence exact strings ∥ ok
 *   typing truncated JSON M_BAD_JSON ∥ boolean typing ok
 *   read_markers invite + ban + knock Not a member ∥ joined markers ok
 *   cross-domain: OFFLINE + typing truncated + markers knock ∥ oks
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
// OFFLINE / UNAVAILABLE / oNline case pins of valid states ∥ ok
// ---------------------------------------------------------------------------

describe('presence fifth-wave concurrent valid-state case soft after #327', () => {
  const cases: Array<{ label: string; body: unknown; error: string }> = [
    {
      label: 'OFFLINE-upper',
      body: { presence: 'OFFLINE' },
      error: 'Invalid presence state: OFFLINE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Offline-mixed',
      body: { presence: 'Offline' },
      error: 'Invalid presence state: Offline. Must be one of: online, offline, unavailable',
    },
    {
      label: 'UNAVAILABLE-upper',
      body: { presence: 'UNAVAILABLE' },
      error: 'Invalid presence state: UNAVAILABLE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Unavailable-mixed',
      body: { presence: 'Unavailable' },
      error: 'Invalid presence state: Unavailable. Must be one of: online, offline, unavailable',
    },
    {
      label: 'oNline-mixed',
      body: { presence: 'oNline' },
      error: 'Invalid presence state: oNline. Must be one of: online, offline, unavailable',
    },
    {
      label: 'tab-whitespace',
      body: { presence: '\tonline' },
      error: 'Invalid presence state: \tonline. Must be one of: online, offline, unavailable',
    },
    {
      label: 'newline-whitespace',
      body: { presence: 'offline\n' },
      error: 'Invalid presence state: offline\n. Must be one of: online, offline, unavailable',
    },
    {
      label: 'trailing-space-offline',
      body: { presence: 'offline ' },
      error: 'Invalid presence state: offline . Must be one of: online, offline, unavailable',
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

  it('OFFLINE ∥ UNAVAILABLE ∥ oNline ∥ Offline ∥ offline under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OFFLINE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'UNAVAILABLE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'oNline' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'Offline' }),
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
        'Invalid presence state: OFFLINE. Must be one of: online, offline, unavailable',
        'Invalid presence state: UNAVAILABLE. Must be one of: online, offline, unavailable',
        'Invalid presence state: oNline. Must be one of: online, offline, unavailable',
        'Invalid presence state: Offline. Must be one of: online, offline, unavailable',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Typing truncated JSON badJson ∥ boolean ok — residual soft concurrent
// ---------------------------------------------------------------------------

describe('typing fifth-wave concurrent truncated badJson soft after #327', () => {
  it('truncated JSON ∥ typing true under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{"typing":tru',
        },
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 1000 }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(softBody(results, 200).body).toEqual({});
  });

  it('empty body ∥ truncated ∥ typing false under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '',
        },
        env
      ),
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{"typing":',
        },
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(
      results.filter((r) => r.status === 400).every((r) => r.body.errcode === 'M_BAD_JSON')
    ).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`typing truncated badJson flood-${i} ∥ ok`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const results = await Promise.all([
        typingReq(
          typingPath(USER_ENC),
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...AUTH },
            body: `{"typing":fals`,
          },
          env
        ),
        typingReq(
          typingPath(USER_ENC),
          jsonInit('PUT', { typing: i % 2 === 0, timeout: 500 }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body.errcode).toBe('M_BAD_JSON');
    });
  }
});

// ---------------------------------------------------------------------------
// read_markers invite/ban/knock membership soft ∥ joined markers ok
// ---------------------------------------------------------------------------

describe('receipts fifth-wave concurrent read_markers membership soft after #327', () => {
  const markersPath = (roomEnc = ROOM_ENC) =>
    `/_matrix/client/v3/rooms/${roomEnc}/read_markers`;

  for (const membership of ['invite', 'ban', 'knock'] as const) {
    it(`read_markers ${membership} Not a member ∥ joined markers ok`, async () => {
      const softRoom = `!rm-${membership}:example.com`;
      const env = createEnv({
        db: createSharedDb({
          memberships: [
            { room_id: softRoom, user_id: USER, membership },
            { room_id: ROOM, user_id: USER, membership: 'join' },
          ],
        }),
      });
      const results = await Promise.all([
        receiptsReq(
          markersPath(encodeURIComponent(softRoom)),
          jsonInit('POST', { 'm.fully_read': '$e-soft:example.com' }),
          env
        ),
        receiptsReq(
          markersPath(),
          jsonInit('POST', { 'm.fully_read': '$e-ok:example.com' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
      expect(softBody(results, 200).body).toEqual({});
    });
  }

  it('invite + ban + knock markers ∥ two joined under race', async () => {
    const env = createEnv({
      db: createSharedDb({
        memberships: [
          { room_id: '!rmi:example.com', user_id: USER, membership: 'invite' },
          { room_id: '!rmb:example.com', user_id: USER, membership: 'ban' },
          { room_id: '!rmk:example.com', user_id: USER, membership: 'knock' },
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'join' },
        ],
      }),
    });
    const results = await Promise.all([
      receiptsReq(
        markersPath(encodeURIComponent('!rmi:example.com')),
        jsonInit('POST', { 'm.fully_read': '$a:example.com' }),
        env
      ),
      receiptsReq(
        markersPath(encodeURIComponent('!rmb:example.com')),
        jsonInit('POST', { 'm.fully_read': '$b:example.com' }),
        env
      ),
      receiptsReq(
        markersPath(encodeURIComponent('!rmk:example.com')),
        jsonInit('POST', { 'm.fully_read': '$c:example.com' }),
        env
      ),
      receiptsReq(
        markersPath(),
        jsonInit('POST', { 'm.fully_read': '$ok1:example.com', 'm.read': '$ok1r:example.com' }),
        env
      ),
      receiptsReq(
        markersPath(ROOM2_ENC),
        jsonInit('POST', { 'm.read.private': '$ok2:example.com' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(3);
    expect(
      results.filter((r) => r.status === 403).every((r) => r.body.error === NOT_A_MEMBER.error)
    ).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`read_markers membership soft flood-${i}`, async () => {
      const softRoom = `!rmf${i}:example.com`;
      const membership = (['invite', 'ban', 'knock'] as const)[i % 3];
      const env = createEnv({
        db: createSharedDb({
          memberships: [
            { room_id: softRoom, user_id: USER, membership },
            { room_id: ROOM, user_id: USER, membership: 'join' },
          ],
        }),
      });
      const results = await Promise.all([
        receiptsReq(
          markersPath(encodeURIComponent(softRoom)),
          jsonInit('POST', { 'm.fully_read': `$s-${i}:example.com` }),
          env
        ),
        receiptsReq(
          markersPath(),
          jsonInit('POST', { 'm.fully_read': `$ok-${i}:example.com` }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 403]);
      expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-domain fifth-wave soft isolation
// ---------------------------------------------------------------------------

describe('presence/receipts/typing fifth-wave cross-domain soft isolation after #327', () => {
  it('OFFLINE + typing truncated + markers knock ∥ three successes', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'knock' },
        ],
      }),
    });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OFFLINE' }),
        env
      ),
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{"typing":tru',
        },
        env
      ),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM2_ENC}/read_markers`,
        jsonInit('POST', { 'm.fully_read': '$x:example.com' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'offline' }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
      receiptsReq(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`,
        jsonInit('POST', { 'm.fully_read': '$ok:example.com' }),
        env
      ),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 400).body.error).toMatch(
      /Invalid presence state: OFFLINE|Could not parse request body as JSON/
    );
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain fifth-wave soft isolation flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!s5${i}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            {
              room_id: softRoom,
              user_id: USER,
              membership: (['invite', 'ban', 'knock'] as const)[i % 3],
            },
          ],
        }),
      });
      const badPresence =
        i % 3 === 0 ? 'OFFLINE' : i % 3 === 1 ? 'UNAVAILABLE' : 'oNline';
      const results = await Promise.all([
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: badPresence }),
          env
        ),
        typingReq(
          typingPath(USER_ENC),
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...AUTH },
            body: '{"typing":',
          },
          env
        ),
        receiptsReq(
          `/_matrix/client/v3/rooms/${encodeURIComponent(softRoom)}/read_markers`,
          jsonInit('POST', { 'm.fully_read': `$x-${i}:example.com` }),
          env
        ),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'unavailable' }),
          env
        ),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 200 }), env),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.status === 400)).toHaveLength(2);
      expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    });
  }
});
