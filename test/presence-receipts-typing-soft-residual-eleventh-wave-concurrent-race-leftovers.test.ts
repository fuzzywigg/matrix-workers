/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #403 — niche
 * presence/receipts/typing soft residual *eleventh-wave* concurrent-race leftovers
 * (tip past #403 tenth / f933abf).
 *
 * Unsaturated by waves #301/#305/#318/#327/#334/#341/#357/#371/#397/#403:
 *   never OnliNe / oFflinE / UNAVAILAbLE / OfFLinE case pins,
 *   never Working/Commuting/OutOfOffice/OnCall/Dozing invalid pins,
 *   never hair-space / ideographic-space / trailing-tab whitespace (`\u200aonline`,
 *     `\u3000online`, `online\t`),
 *   never typing root-string `"FALSE"` / root-number `2` → Missing typing ∥ boolean ok,
 *   never typing JOIN-membership (case-mutated) Not a member ∥ join ok,
 *   never receipt case-mutated types M.Read.PRIVATE/m.FULLY_READ/M.Read/
 *     m.READ.private under soft residual PA.
 *
 * Gap table (why leftover after #403 tenth):
 *   OnliNe/oFflinE/UNAVAILAbLE + Working/Commuting/Dozing + hair/ideo/trail-tab ∥ ok
 *   typing root-string/number Missing typing + JOIN-membership Not a member ∥ ok
 *   receipt case-mutated Invalid type matrix ∥ m.read ok
 *   cross-domain: OnliNe + root-string `"FALSE"` typing + M.Read.PRIVATE ∥ oks
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
// OnliNe / oFflinE / UNAVAILAbLE + Working/Commuting/Dozing + hair/ideo/trail-tab ∥ ok
// ---------------------------------------------------------------------------

describe('presence eleventh-wave concurrent case/whitespace soft after #403', () => {
  const cases: Array<{ label: string; body: unknown; error: string }> = [
    {
      label: 'OnliNe-mixed',
      body: { presence: 'OnliNe' },
      error: 'Invalid presence state: OnliNe. Must be one of: online, offline, unavailable',
    },
    {
      label: 'oFflinE-mixed',
      body: { presence: 'oFflinE' },
      error: 'Invalid presence state: oFflinE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'UNAVAILAbLE-mixed',
      body: { presence: 'UNAVAILAbLE' },
      error: 'Invalid presence state: UNAVAILAbLE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'OfFLinE-mixed',
      body: { presence: 'OfFLinE' },
      error: 'Invalid presence state: OfFLinE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Working-title',
      body: { presence: 'Working' },
      error: 'Invalid presence state: Working. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Commuting-title',
      body: { presence: 'Commuting' },
      error: 'Invalid presence state: Commuting. Must be one of: online, offline, unavailable',
    },
    {
      label: 'OutOfOffice-title',
      body: { presence: 'OutOfOffice' },
      error: 'Invalid presence state: OutOfOffice. Must be one of: online, offline, unavailable',
    },
    {
      label: 'OnCall-title',
      body: { presence: 'OnCall' },
      error: 'Invalid presence state: OnCall. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Dozing-title',
      body: { presence: 'Dozing' },
      error: 'Invalid presence state: Dozing. Must be one of: online, offline, unavailable',
    },
    {
      label: 'hair-space-whitespace',
      body: { presence: '\u200aonline' },
      error: 'Invalid presence state: \u200aonline. Must be one of: online, offline, unavailable',
    },
    {
      label: 'ideographic-space-whitespace',
      body: { presence: '\u3000online' },
      error: 'Invalid presence state: \u3000online. Must be one of: online, offline, unavailable',
    },
    {
      label: 'trailing-tab-whitespace',
      body: { presence: 'online\t' },
      error: 'Invalid presence state: online\t. Must be one of: online, offline, unavailable',
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

  it('OnliNe ∥ oFflinE ∥ Working ∥ Dozing ∥ offline under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OnliNe' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'oFflinE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'Working' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'Dozing' }),
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
        'Invalid presence state: OnliNe. Must be one of: online, offline, unavailable',
        'Invalid presence state: oFflinE. Must be one of: online, offline, unavailable',
        'Invalid presence state: Working. Must be one of: online, offline, unavailable',
        'Invalid presence state: Dozing. Must be one of: online, offline, unavailable',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Typing root-string/number Missing typing + JOIN-membership Not a member ∥ ok
// ---------------------------------------------------------------------------

describe('typing eleventh-wave concurrent root-string-number + JOIN-membership soft after #403', () => {
  it('root-string "FALSE" Missing typing ∥ boolean true under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"FALSE"',
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

  it('root-number 2 Missing typing ∥ boolean false under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '2',
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

  it('JOIN membership Not a member ∥ join ok under race', async () => {
    const roomDO = createRoomDOStub();
    const softRoom = '!JOIN-mem:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: softRoom, user_id: USER, membership: 'JOIN' },
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

  it('root-string + JOIN-membership ∥ two oks under race', async () => {
    const roomDO = createRoomDOStub();
    const softRoom = '!JOIN:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: softRoom, user_id: USER, membership: 'JOIN' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"FALSE"',
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
    it(`typing root-string-number / JOIN-mem flood-${i} ∥ ok`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!JOIN${i}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            { room_id: softRoom, user_id: USER, membership: 'JOIN' },
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
                body: i % 4 === 0 ? '"FALSE"' : '-1',
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

describe('receipts eleventh-wave concurrent case-mutated Invalid type soft after #403', () => {
  for (const badType of ['M.Read.PRIVATE', 'm.FULLY_READ', 'M.Read', 'm.READ.private'] as const) {
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

  it('M.Read.PRIVATE ∥ m.FULLY_READ ∥ M.Read ∥ m.read + m.read.private under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      receiptsReq(receiptPath('M.Read.PRIVATE', '$a:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.FULLY_READ', '$b:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('M.Read', '$c:example.com'), jsonInit('POST', {}), env),
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
        'Invalid receipt type: M.Read.PRIVATE',
        'Invalid receipt type: M.Read',
        'Invalid receipt type: m.FULLY_READ',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`receipt case-mutated type flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const badType = (['M.Read.PRIVATE', 'm.FULLY_READ', 'M.Read', 'm.READ.private'] as const)[i % 4];
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
// Cross-domain eleventh-wave soft isolation
// ---------------------------------------------------------------------------

describe('presence/receipts/typing eleventh-wave cross-domain soft isolation after #403', () => {
  it('OnliNe + root-string typing + M.Read.PRIVATE ∥ three successes', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OnliNe' }),
        env
      ),
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"FALSE"',
        },
        env
      ),
      receiptsReq(receiptPath('M.Read.PRIVATE', '$x:example.com'), jsonInit('POST', {}), env),
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
        'Invalid presence state: OnliNe. Must be one of: online, offline, unavailable',
        'Invalid receipt type: M.Read.PRIVATE',
        'Missing required parameter: typing',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain eleventh-wave soft isolation flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const badPresence = (['OnliNe', 'oFflinE', 'Working'] as const)[i % 3];
      const badType = (['M.Read.PRIVATE', 'm.FULLY_READ', 'M.Read'] as const)[i % 3];
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
            body: i % 2 === 0 ? '"FALSE"' : '-1',
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
        receiptsReq(receiptPath('m.read', `$ok-${i}:example.com`), jsonInit('POST', {}), env),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    });
  }
});
