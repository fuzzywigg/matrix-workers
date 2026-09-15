/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #341 — niche
 * presence/receipts/typing soft residual *seventh-wave* concurrent-race leftovers
 * (tip past #341 sixth).
 *
 * Unsaturated by waves #301/#305/#318/#327/#334/#341:
 *   never Online/OFFLINE-adjacent ONLine / offlINE / UnAvailable / uNavailable,
 *   never Invisible/Hidden/XA/Chat/BRB/Available invalid pins,
 *   never leading-space / form-feed whitespace (` online`, `\fonline`),
 *   never typing root-string `"true"` / root-number `1` → Missing typing ∥ boolean ok,
 *   never typing leave-membership Not a member ∥ join ok,
 *   never receipt case-mutated types m.READ/M.read/m.Fully_Read/
 *     M.READ.PRIVATE under soft residual PA.
 *
 * Gap table (why leftover after #341 sixth):
 *   ONLine/offlINE/UnAvailable + Invisible/Hidden/XA + space/FF whitespace ∥ ok
 *   typing root-string/number Missing typing + leave-membership Not a member ∥ ok
 *   receipt case-mutated Invalid type matrix ∥ m.read ok
 *   cross-domain: ONLine + root-string typing + m.READ ∥ oks
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
const receiptPath = (type: string, eventId: string, roomEnc = ROOM_ENC) =>
  `/_matrix/client/v3/rooms/${roomEnc}/receipt/${type}/${encodeURIComponent(eventId)}`;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ONLine / offlINE / UnAvailable + Invisible/Hidden/XA + space/FF whitespace ∥ ok
// ---------------------------------------------------------------------------

describe('presence seventh-wave concurrent case/whitespace soft after #341', () => {
  const cases: Array<{ label: string; body: unknown; error: string }> = [
    {
      label: 'ONLine-mixed',
      body: { presence: 'ONLine' },
      error: 'Invalid presence state: ONLine. Must be one of: online, offline, unavailable',
    },
    {
      label: 'offlINE-mixed',
      body: { presence: 'offlINE' },
      error: 'Invalid presence state: offlINE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'UnAvailable-mixed',
      body: { presence: 'UnAvailable' },
      error: 'Invalid presence state: UnAvailable. Must be one of: online, offline, unavailable',
    },
    {
      label: 'uNavailable-mixed',
      body: { presence: 'uNavailable' },
      error: 'Invalid presence state: uNavailable. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Online-title',
      body: { presence: 'Online' },
      error: 'Invalid presence state: Online. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Invisible-title',
      body: { presence: 'Invisible' },
      error: 'Invalid presence state: Invisible. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Hidden-title',
      body: { presence: 'Hidden' },
      error: 'Invalid presence state: Hidden. Must be one of: online, offline, unavailable',
    },
    {
      label: 'XA-upper',
      body: { presence: 'XA' },
      error: 'Invalid presence state: XA. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Chat-title',
      body: { presence: 'Chat' },
      error: 'Invalid presence state: Chat. Must be one of: online, offline, unavailable',
    },
    {
      label: 'BRB-upper',
      body: { presence: 'BRB' },
      error: 'Invalid presence state: BRB. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Available-title',
      body: { presence: 'Available' },
      error: 'Invalid presence state: Available. Must be one of: online, offline, unavailable',
    },
    {
      label: 'leading-space',
      body: { presence: ' online' },
      error: 'Invalid presence state:  online. Must be one of: online, offline, unavailable',
    },
    {
      label: 'form-feed-whitespace',
      body: { presence: '\fonline' },
      error: 'Invalid presence state: \fonline. Must be one of: online, offline, unavailable',
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

  it('ONLine ∥ offlINE ∥ Invisible ∥ XA ∥ offline under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'ONLine' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'offlINE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'Invisible' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'XA' }),
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
        'Invalid presence state: ONLine. Must be one of: online, offline, unavailable',
        'Invalid presence state: offlINE. Must be one of: online, offline, unavailable',
        'Invalid presence state: Invisible. Must be one of: online, offline, unavailable',
        'Invalid presence state: XA. Must be one of: online, offline, unavailable',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Typing root-string/number Missing typing + leave-membership Not a member ∥ ok
// ---------------------------------------------------------------------------

describe('typing seventh-wave concurrent root-scalar + leave-membership soft after #341', () => {
  it('root-string "true" Missing typing ∥ boolean true under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"true"',
        },
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 1000 }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: typing',
    });
    expect(softBody(results, 200).body).toEqual({});
  });

  it('root-number 1 Missing typing ∥ boolean false under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '1',
        },
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(softBody(results, 400).body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: typing',
    });
    expect(softBody(results, 200).body).toEqual({});
  });

  it('leave membership Not a member ∥ join ok under race', async () => {
    const roomDO = createRoomDOStub();
    const softRoom = '!leave-mem:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: softRoom, user_id: USER, membership: 'leave' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC, encodeURIComponent(softRoom)),
        jsonInit('PUT', { typing: true, timeout: 500 }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
    expect(softBody(results, 200).body).toEqual({});
  });

  it('root-string + leave-membership ∥ two oks under race', async () => {
    const roomDO = createRoomDOStub();
    const softRoom = '!left:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: softRoom, user_id: USER, membership: 'leave' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"true"',
        },
        env
      ),
      typingReq(
        typingPath(USER_ENC, encodeURIComponent(softRoom)),
        jsonInit('PUT', { typing: true }),
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 200 }), env),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: false }), env),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(softBody(results, 400).body.error).toBe('Missing required parameter: typing');
    expect(softBody(results, 403).body).toEqual(NOT_A_MEMBER);
  });

  for (let i = 0; i < 6; i++) {
    it(`typing root-scalar / leave-mem flood-${i} ∥ ok`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!lv${i}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            { room_id: softRoom, user_id: USER, membership: 'leave' },
          ],
        }),
      });
      const results = await Promise.all([
        i % 2 === 0
          ? typingReq(
              typingPath(USER_ENC),
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...AUTH },
                body: i % 4 === 0 ? '"true"' : '1',
              },
              env
            )
          : typingReq(
              typingPath(USER_ENC, encodeURIComponent(softRoom)),
              jsonInit('PUT', { typing: true }),
              env
            ),
        typingReq(
          typingPath(USER_ENC),
          jsonInit('PUT', { typing: i % 2 === 0, timeout: 500 }),
          env
        ),
      ]);
      expect(statusesOf(results)[0]).toBe(200);
      expect([400, 403]).toContain(statusesOf(results)[1]);
    });
  }
});

// ---------------------------------------------------------------------------
// Receipt case-mutated Invalid type matrix ∥ m.read ok
// ---------------------------------------------------------------------------

describe('receipts seventh-wave concurrent case-mutated Invalid type soft after #341', () => {
  for (const badType of ['m.READ', 'M.read', 'm.Fully_Read', 'M.READ.PRIVATE'] as const) {
    it(`exact Invalid receipt type '${badType}' ∥ m.read under race`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const results = await Promise.all([
        receiptsReq(
          receiptPath(badType, '$bad:example.com'),
          jsonInit('POST', {}),
          env
        ),
        receiptsReq(
          receiptPath('m.read', '$ok:example.com'),
          jsonInit('POST', {}),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(softBody(results, 400).body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: `Invalid receipt type: ${badType}`,
      });
      expect(softBody(results, 200).body).toEqual({});
    });
  }

  it('m.READ ∥ M.read ∥ m.Fully_Read ∥ m.read + m.read.private under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      receiptsReq(receiptPath('m.READ', '$a:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('M.read', '$b:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.Fully_Read', '$c:example.com'), jsonInit('POST', {}), env),
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
        'Invalid receipt type: M.read',
        'Invalid receipt type: m.Fully_Read',
        'Invalid receipt type: m.READ',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`receipt case-mutated type flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const badType = (['m.READ', 'M.read', 'm.Fully_Read', 'M.READ.PRIVATE'] as const)[i % 4];
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
// Cross-domain seventh-wave soft isolation
// ---------------------------------------------------------------------------

describe('presence/receipts/typing seventh-wave cross-domain soft isolation after #341', () => {
  it('ONLine + root-string typing + m.READ ∥ three successes', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'ONLine' }),
        env
      ),
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"true"',
        },
        env
      ),
      receiptsReq(receiptPath('m.READ', '$x:example.com'), jsonInit('POST', {}), env),
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
        'Invalid presence state: ONLine. Must be one of: online, offline, unavailable',
        'Invalid receipt type: m.READ',
        'Missing required parameter: typing',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain seventh-wave soft isolation flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const badPresence =
        i % 3 === 0 ? 'ONLine' : i % 3 === 1 ? 'offlINE' : 'Invisible';
      const badType = (['m.READ', 'M.read', 'm.Fully_Read'] as const)[i % 3];
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
            body: i % 2 === 0 ? '"true"' : '1',
          },
          env
        ),
        receiptsReq(receiptPath(badType, `$x-${i}:example.com`), jsonInit('POST', {}), env),
        presenceReq(
          `/_matrix/client/v3/presence/${USER_ENC}/status`,
          jsonInit('PUT', { presence: 'unavailable' }),
          env
        ),
        typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 200 }), env),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    });
  }
});
