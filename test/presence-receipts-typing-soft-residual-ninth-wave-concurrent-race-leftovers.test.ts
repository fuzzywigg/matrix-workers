/**
 * TOKENMAXX HEAVY tip-relaunch deepen after merged #371 — niche
 * presence/receipts/typing soft residual *ninth-wave* concurrent-race leftovers
 * (tip past #371 eighth).
 *
 * Unsaturated by waves #301/#305/#318/#327/#334/#341/#357/#371:
 *   never oNlInE / OfFlInE / uNaVaIlAbLe / OnLINE / ofFLINE / UNAVAILABle,
 *   never AFK/Focused/Sleeping/Gone/ExtendedAway invalid pins,
 *   never ZWSP / BOM / trailing-NBSP / trailing-VT whitespace (`\u200bonline`,
 *     `\ufeffonline`, `offline\u00a0`, `online\v`),
 *   never typing root-string `"null"` / `"yes"` / root-number `-1` / `2` →
 *     Missing typing ∥ boolean ok,
 *   never typing ban-membership Not a member ∥ join ok,
 *   never receipt case-mutated types M.FULLY_READ/m.Fully_READ/M.read.private/
 *     m.Read.Private under soft residual PA.
 *
 * Gap table (why leftover after #371 eighth):
 *   oNlInE/OfFlInE/uNaVaIlAbLe + AFK/Focused/Sleeping + ZWSP/BOM/NBSP/VT ∥ ok
 *   typing root-string/number Missing typing + ban-membership Not a member ∥ ok
 *   receipt case-mutated Invalid type matrix ∥ m.read ok
 *   cross-domain: oNlInE + root-string `"null"` typing + M.FULLY_READ ∥ oks
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
// oNlInE / OfFlInE / uNaVaIlAbLe + AFK/Focused/Sleeping + ZWSP/BOM/NBSP/VT ∥ ok
// ---------------------------------------------------------------------------

describe('presence ninth-wave concurrent case/whitespace soft after #371', () => {
  const cases: Array<{ label: string; body: unknown; error: string }> = [
    {
      label: 'oNlInE-mixed',
      body: { presence: 'oNlInE' },
      error: 'Invalid presence state: oNlInE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'OfFlInE-mixed',
      body: { presence: 'OfFlInE' },
      error: 'Invalid presence state: OfFlInE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'uNaVaIlAbLe-mixed',
      body: { presence: 'uNaVaIlAbLe' },
      error: 'Invalid presence state: uNaVaIlAbLe. Must be one of: online, offline, unavailable',
    },
    {
      label: 'OnLINE-mixed',
      body: { presence: 'OnLINE' },
      error: 'Invalid presence state: OnLINE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'ofFLINE-mixed',
      body: { presence: 'ofFLINE' },
      error: 'Invalid presence state: ofFLINE. Must be one of: online, offline, unavailable',
    },
    {
      label: 'UNAVAILABle-mixed',
      body: { presence: 'UNAVAILABle' },
      error: 'Invalid presence state: UNAVAILABle. Must be one of: online, offline, unavailable',
    },
    {
      label: 'AFK-title',
      body: { presence: 'AFK' },
      error: 'Invalid presence state: AFK. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Focused-title',
      body: { presence: 'Focused' },
      error: 'Invalid presence state: Focused. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Sleeping-title',
      body: { presence: 'Sleeping' },
      error: 'Invalid presence state: Sleeping. Must be one of: online, offline, unavailable',
    },
    {
      label: 'Gone-title',
      body: { presence: 'Gone' },
      error: 'Invalid presence state: Gone. Must be one of: online, offline, unavailable',
    },
    {
      label: 'ExtendedAway-title',
      body: { presence: 'ExtendedAway' },
      error: 'Invalid presence state: ExtendedAway. Must be one of: online, offline, unavailable',
    },
    {
      label: 'zwsp-whitespace',
      body: { presence: '\u200bonline' },
      error: 'Invalid presence state: \u200bonline. Must be one of: online, offline, unavailable',
    },
    {
      label: 'bom-whitespace',
      body: { presence: '\ufeffonline' },
      error: 'Invalid presence state: \ufeffonline. Must be one of: online, offline, unavailable',
    },
    {
      label: 'trailing-nbsp-whitespace',
      body: { presence: 'offline\u00a0' },
      error: 'Invalid presence state: offline\u00a0. Must be one of: online, offline, unavailable',
    },
    {
      label: 'trailing-VT-whitespace',
      body: { presence: 'online\v' },
      error: 'Invalid presence state: online\v. Must be one of: online, offline, unavailable',
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

  it('oNlInE ∥ OfFlInE ∥ AFK ∥ Sleeping ∥ offline under race', async () => {
    const env = createEnv();
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'oNlInE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'OfFlInE' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'AFK' }),
        env
      ),
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'Sleeping' }),
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
        'Invalid presence state: oNlInE. Must be one of: online, offline, unavailable',
        'Invalid presence state: OfFlInE. Must be one of: online, offline, unavailable',
        'Invalid presence state: AFK. Must be one of: online, offline, unavailable',
        'Invalid presence state: Sleeping. Must be one of: online, offline, unavailable',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Typing root-string/number Missing typing + ban-membership Not a member ∥ ok
// ---------------------------------------------------------------------------

describe('typing ninth-wave concurrent root-scalar + ban-membership soft after #371', () => {
  it('root-string "null" Missing typing ∥ boolean true under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"null"',
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

  it('root-string "yes" Missing typing ∥ boolean false under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"yes"',
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

  it('root-number -1 Missing typing ∥ boolean true under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '-1',
        },
        env
      ),
      typingReq(typingPath(USER_ENC), jsonInit('PUT', { typing: true, timeout: 500 }), env),
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

  it('ban membership Not a member ∥ join ok under race', async () => {
    const roomDO = createRoomDOStub();
    const softRoom = '!ban-mem:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: softRoom, user_id: USER, membership: 'ban' },
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

  it('root-string + ban-membership ∥ two oks under race', async () => {
    const roomDO = createRoomDOStub();
    const softRoom = '!ban:example.com';
    const env = createEnv({
      roomDO,
      db: createSharedDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: softRoom, user_id: USER, membership: 'ban' },
        ],
      }),
    });
    const results = await Promise.all([
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"null"',
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
    it(`typing root-scalar / ban-mem flood-${i} ∥ ok`, async () => {
      const roomDO = createRoomDOStub();
      const softRoom = `!ban${i}:example.com`;
      const env = createEnv({
        roomDO,
        db: createSharedDb({
          memberships: [
            { room_id: ROOM, user_id: USER, membership: 'join' },
            { room_id: softRoom, user_id: USER, membership: 'ban' },
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
                body: i % 4 === 0 ? '"null"' : i % 4 === 2 ? '"yes"' : '-1',
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

describe('receipts ninth-wave concurrent case-mutated Invalid type soft after #371', () => {
  for (const badType of ['M.FULLY_READ', 'm.Fully_READ', 'M.read.private', 'm.Read.Private'] as const) {
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

  it('M.FULLY_READ ∥ m.Fully_READ ∥ M.read.private ∥ m.read + m.read.private under race', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      receiptsReq(receiptPath('M.FULLY_READ', '$a:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('m.Fully_READ', '$b:example.com'), jsonInit('POST', {}), env),
      receiptsReq(receiptPath('M.read.private', '$c:example.com'), jsonInit('POST', {}), env),
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
        'Invalid receipt type: M.FULLY_READ',
        'Invalid receipt type: M.read.private',
        'Invalid receipt type: m.Fully_READ',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`receipt case-mutated type flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const badType = (['M.FULLY_READ', 'm.Fully_READ', 'M.read.private', 'm.Read.Private'] as const)[i % 4];
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
// Cross-domain ninth-wave soft isolation
// ---------------------------------------------------------------------------

describe('presence/receipts/typing ninth-wave cross-domain soft isolation after #371', () => {
  it('oNlInE + root-string typing + M.FULLY_READ ∥ three successes', async () => {
    const roomDO = createRoomDOStub();
    const env = createEnv({ roomDO });
    const results = await Promise.all([
      presenceReq(
        `/_matrix/client/v3/presence/${USER_ENC}/status`,
        jsonInit('PUT', { presence: 'oNlInE' }),
        env
      ),
      typingReq(
        typingPath(USER_ENC),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"null"',
        },
        env
      ),
      receiptsReq(receiptPath('M.FULLY_READ', '$x:example.com'), jsonInit('POST', {}), env),
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
        'Invalid presence state: oNlInE. Must be one of: online, offline, unavailable',
        'Invalid receipt type: M.FULLY_READ',
        'Missing required parameter: typing',
      ].sort()
    );
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-domain ninth-wave soft isolation flood-${i}`, async () => {
      const roomDO = createRoomDOStub();
      const env = createEnv({ roomDO });
      const badPresence =
        i % 3 === 0 ? 'oNlInE' : i % 3 === 1 ? 'OfFlInE' : 'AFK';
      const badType = (['M.FULLY_READ', 'm.Fully_READ', 'M.read.private'] as const)[i % 3];
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
            body: i % 2 === 0 ? '"null"' : '-1',
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
