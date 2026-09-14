/**
 * TOKENMAXX HEAVY device-list-sync deepen — /keys/changes + empty /keys/query maps.
 * Existing module: src/api/keys.ts. Tests-only — no product inventing.
 * Covers update/delete deltas → changed/left, stale stream windows, empty user
 * device maps, and partial EDU / signature failures already coded.
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

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async () => true),
  };
});

import keysApp from '../src/api/keys';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE = 'DEVICEA';
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const ROOM = '!shared:example.com';

type SqlCall = { sql: string; args: unknown[] };

type KeyChange = {
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
};

type Membership = { room_id: string; user_id: string; membership: string };

function mockKv(data: Record<string, string> = {}) {
  const puts: SqlCall[] = [];
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
    put: async (key: string, value: string) => {
      data[key] = value;
      puts.push({ sql: key, args: [value] });
    },
    delete: async (key: string) => {
      delete data[key];
    },
  } as unknown as KVNamespace & { data: Record<string, string>; puts: SqlCall[] };
}

function createFederationStub(opts: { fail?: boolean } = {}) {
  const fetches: Array<{ url: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(req: Request) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, body });
      if (opts.fail) throw new Error('federation EDU boom');
      return new Response('{}', { status: 200 });
    },
  };
}

function createUserKeysStub(opts: {
  deviceKeys?: Record<string, Record<string, unknown> | null>;
  crossSigning?: Record<string, unknown>;
  failGet?: boolean;
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  return {
    async fetch(req: Request) {
      if (opts.failGet) throw new Error('user keys DO boom');
      const url = new URL(req.url);
      if (url.pathname === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) {
          // Match production stub pattern: 200 + null for missing (not 404)
          return Response.json(deviceKeys[deviceId] ?? null);
        }
        return Response.json(deviceKeys);
      }
      if (url.pathname === '/device-keys/list') {
        return Response.json(Object.keys(deviceKeys).filter((k) => deviceKeys[k]));
      }
      if (url.pathname === '/device-keys/put') {
        return new Response('{}', { status: 200 });
      }
      if (url.pathname === '/cross-signing/get') {
        return Response.json(crossSigning);
      }
      if (url.pathname === '/cross-signing/put') {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    },
  };
}

function createKeysDb(opts: {
  keyChanges?: KeyChange[];
  memberships?: Membership[];
  streamPositions?: Record<string, number>;
  throwOnSignatureInsert?: boolean;
} = {}) {
  const keyChanges = [...(opts.keyChanges ?? [])];
  const memberships = [...(opts.memberships ?? [])];
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const inserts: SqlCall[] = [];
  const signatures: unknown[] = [];

  const db = {
    keyChanges,
    memberships,
    streamPositions,
    inserts,
    signatures,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT position FROM stream_positions')) {
                const name = args[0] as string;
                return { position: streamPositions[name] ?? 1 } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM cross_signing_keys')) {
                return { count: 0 } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM idp_user_links')) {
                return { count: 0 } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                return { password_hash: 'mockok:pw' } as T;
              }
              return null as T;
            },
            async all<T>() {
              // keys/changes shared-room query
              if (
                sql.includes('FROM device_key_changes dkc') &&
                sql.includes('room_memberships')
              ) {
                const [fromPos, toPos, requester] = args as [number, number, string];
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const sharedUsers = new Set(
                  memberships
                    .filter((m) => joinedRooms.has(m.room_id) && m.membership === 'join')
                    .map((m) => m.user_id)
                );
                const rows = keyChanges
                  .filter(
                    (c) =>
                      c.stream_position > fromPos &&
                      c.stream_position <= toPos &&
                      sharedUsers.has(c.user_id)
                  )
                  .map((c) => ({ user_id: c.user_id, change_type: c.change_type }));
                const seen = new Set<string>();
                const distinct = rows.filter((r) => {
                  const k = `${r.user_id}:${r.change_type}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
                return { results: distinct as unknown as T[] };
              }

              // getServersInRoomsWithUser
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                const requester = args[0] as string;
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const servers = new Set<string>();
                for (const m of memberships) {
                  if (!joinedRooms.has(m.room_id) || m.membership !== 'join') continue;
                  if (m.user_id === requester) continue;
                  const idx = m.user_id.indexOf(':');
                  if (idx > 0) servers.add(m.user_id.slice(idx + 1));
                }
                return {
                  results: [...servers].map((server_name) => ({ server_name })),
                } as { results: T[] };
              }

              if (sql.includes('FROM cross_signing_signatures')) {
                return { results: [] as T[] };
              }

              return { results: [] as T[] };
            },
            async run() {
              inserts.push({ sql, args });
              if (sql.includes('UPDATE stream_positions')) {
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true };
              }
              if (sql.includes('INSERT INTO device_key_changes')) {
                const [userId, deviceId, changeType, streamPosition] = args as [
                  string,
                  string | null,
                  string,
                  number,
                ];
                keyChanges.push({
                  user_id: userId,
                  device_id: deviceId,
                  change_type: changeType,
                  stream_position: streamPosition,
                });
                return { success: true };
              }
              if (sql.includes('INSERT INTO cross_signing_signatures')) {
                if (opts.throwOnSignatureInsert) {
                  throw new Error('sig insert boom');
                }
                signatures.push(args);
                return { success: true };
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}

type KeysDb = ReturnType<typeof createKeysDb>;

function sharedMemberships(...users: string[]): Membership[] {
  return users.map((user_id) => ({
    room_id: ROOM,
    user_id,
    membership: 'join',
  }));
}

function createEnv(opts: {
  db?: KeysDb;
  userKeys?: ReturnType<typeof createUserKeysStub>;
  federation?: ReturnType<typeof createFederationStub>;
  deviceKeysKv?: ReturnType<typeof mockKv>;
  remoteServers?: string[];
} = {}) {
  const db = opts.db ?? createKeysDb();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const federation = opts.federation ?? createFederationStub();
  const deviceKeysKv = opts.deviceKeysKv ?? mockKv();

  // Seed remote memberships for getServersInRoomsWithUser when needed
  if (opts.remoteServers?.length) {
    for (const s of opts.remoteServers) {
      if (!db.memberships.some((m) => m.user_id === `@remote:${s}`)) {
        db.memberships.push(
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM, user_id: `@remote:${s}`, membership: 'join' }
        );
      }
    }
  }

  const fedByServer = new Map<string, ReturnType<typeof createFederationStub>>();

  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    DEVICE_KEYS: deviceKeysKv,
    ONE_TIME_KEYS: mockKv(),
    CACHE: mockKv(),
    ACCOUNT_DATA: mockKv(),
    CROSS_SIGNING_KEYS: mockKv(),
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (id: { name: string }) => {
        if (!fedByServer.has(id.name)) fedByServer.set(id.name, federation);
        return fedByServer.get(id.name)!;
      },
    },
    _db: db,
    _fed: federation,
    _fedByServer: fedByServer,
  } as unknown as Env & {
    _db: KeysDb;
    _fed: ReturnType<typeof createFederationStub>;
    _fedByServer: Map<string, ReturnType<typeof createFederationStub>>;
  };
}

async function request(env: Env, path: string, init: RequestInit = {}) {
  const res = await keysApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  };
}

function deviceKeysPayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER,
    device_id: DEVICE,
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    keys: { 'curve25519:DEVICEA': 'curv', 'ed25519:DEVICEA': 'ed' },
    signatures: { [USER]: { 'ed25519:DEVICEA': 'sig' } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// /keys/changes — added (update) vs deleted (delete) deltas
// ---------------------------------------------------------------------------

describe('keys/changes — added vs deleted deltas', () => {
  it('maps change_type=update to changed and delete to left', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB, CAROL),
        keyChanges: [
          { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 5 },
          { user_id: CAROL, device_id: null, change_type: 'delete', stream_position: 6 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: [BOB], left: [CAROL] });
  });

  it('dedupes repeated update rows for the same user into one changed entry', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          { user_id: BOB, device_id: 'D1', change_type: 'update', stream_position: 2 },
          { user_id: BOB, device_id: 'D2', change_type: 'update', stream_position: 3 },
          { user_id: BOB, device_id: 'D1', change_type: 'update', stream_position: 4 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=1&to=10');
    expect(res.body).toEqual({ changed: [BOB], left: [] });
  });

  it('dedupes repeated delete rows into one left entry', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          { user_id: BOB, device_id: 'D1', change_type: 'delete', stream_position: 2 },
          { user_id: BOB, device_id: 'D2', change_type: 'delete', stream_position: 3 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=1&to=10');
    expect(res.body).toEqual({ changed: [], left: [BOB] });
  });

  it('same user with both update and delete appears in both arrays', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          { user_id: BOB, device_id: 'D1', change_type: 'update', stream_position: 2 },
          { user_id: BOB, device_id: 'D2', change_type: 'delete', stream_position: 3 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=1&to=10');
    expect(res.body).toEqual({ changed: [BOB], left: [BOB] });
  });

  it('non-delete change_types are treated as changed (added path)', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB, CAROL),
        keyChanges: [
          { user_id: BOB, device_id: 'D', change_type: 'create', stream_position: 2 },
          { user_id: CAROL, device_id: 'D', change_type: 'update', stream_position: 3 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=1&to=10');
    expect(res.body).toEqual({
      changed: expect.arrayContaining([BOB, CAROL]),
      left: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Stale stream windows (outside from/to)
// ---------------------------------------------------------------------------

describe('keys/changes — stale stream windows', () => {
  it('excludes changes at or before from and after to', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB, CAROL),
        keyChanges: [
          { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 5 }, // == from → stale
          { user_id: CAROL, device_id: 'D', change_type: 'delete', stream_position: 6 }, // in range
          { user_id: BOB, device_id: 'D2', change_type: 'update', stream_position: 11 }, // > to → stale
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=5&to=10');
    expect(res.body).toEqual({ changed: [], left: [CAROL] });
  });

  it('empty changed/left when entire window is stale relative to data', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 1 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=100&to=200');
    expect(res.body).toEqual({ changed: [], left: [] });
  });

  it('includes change exactly at to bound (stream_position <= to)', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 10 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=10');
    expect(res.body).toEqual({ changed: [BOB], left: [] });
  });

  it('excludes non-shared-room users even with fresh stream positions', async () => {
    const env = createEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          {
            user_id: '@outsider:example.com',
            device_id: 'X',
            change_type: 'update',
            stream_position: 8,
          },
          { user_id: BOB, device_id: 'D', change_type: 'delete', stream_position: 9 },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=20');
    expect(res.body).toEqual({ changed: [], left: [BOB] });
  });
});

// ---------------------------------------------------------------------------
// Empty user device maps (/keys/query)
// ---------------------------------------------------------------------------

describe('keys/query — empty user device maps', () => {
  it('returns empty device map for user with no devices when listing all', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({ deviceKeys: {} }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [BOB]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      device_keys: { [BOB]: {} },
      failures: {},
    });
  });

  it('returns empty device bucket when specific devices are all missing', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({
        deviceKeys: { [DEVICE]: deviceKeysPayload() },
      }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: ['NOSUCH', 'ALSOGONE'] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[USER]).toEqual({});
  });

  it('skips null device entries and keeps only real devices when listing all', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({
        deviceKeys: {
          [DEVICE]: deviceKeysPayload(),
          GONE: null,
        },
      }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER].GONE).toBeUndefined();
  });

  it('returns empty failures map alongside empty device map for ghost user list', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({ deviceKeys: {} }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { ['@ghost:example.com']: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      device_keys: { '@ghost:example.com': {} },
      failures: {},
    });
  });

  it('omitted device_keys yields empty maps and empty failures', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/query', jsonInit('POST', {}));
    expect(res.body).toEqual({
      device_keys: {},
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
      failures: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Partial failures already coded (EDU queue / signature upload)
// ---------------------------------------------------------------------------

describe('keys device-list — partial failures already coded', () => {
  it('upload succeeds when federation device_list_update EDU throws', async () => {
    const fed = createFederationStub({ fail: true });
    const env = createEnv({
      federation: fed,
      remoteServers: [REMOTE],
      db: createKeysDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM, user_id: `@remote:${REMOTE}`, membership: 'join' },
        ],
      }),
    });
    (env as { FEDERATION: { get: () => ReturnType<typeof createFederationStub> } }).FEDERATION.get =
      () => fed;

    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
    expect(env._db.keyChanges.some((c) => c.change_type === 'update')).toBe(true);
  });

  it('signatures/upload records per-key failures without aborting whole request', async () => {
    const db = createKeysDb({ throwOnSignatureInsert: true });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          key1: {
            signatures: { [USER]: { 'ed25519:usk': 'x' } },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      failures: {
        [BOB]: {
          key1: { errcode: 'M_UNKNOWN', error: 'Failed to store signature' },
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Volume: windowed delta matrix
// ---------------------------------------------------------------------------

describe('keys/changes — windowed delta matrix', () => {
  const windows = [
    { from: 0, to: 5, expectChanged: [BOB], expectLeft: [] as string[] },
    { from: 5, to: 10, expectChanged: [] as string[], expectLeft: [CAROL] },
    { from: 0, to: 10, expectChanged: [BOB], expectLeft: [CAROL] },
    { from: 10, to: 20, expectChanged: [] as string[], expectLeft: [] as string[] },
    { from: 3, to: 6, expectChanged: [BOB], expectLeft: [] as string[] },
    { from: 6, to: 7, expectChanged: [] as string[], expectLeft: [CAROL] },
  ];

  for (const w of windows) {
    it(`from=${w.from} to=${w.to} → changed=${JSON.stringify(w.expectChanged)} left=${JSON.stringify(w.expectLeft)}`, async () => {
      const env = createEnv({
        db: createKeysDb({
          memberships: sharedMemberships(USER, BOB, CAROL),
          keyChanges: [
            { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 4 },
            { user_id: CAROL, device_id: 'D', change_type: 'delete', stream_position: 7 },
            {
              user_id: '@outsider:example.com',
              device_id: 'X',
              change_type: 'update',
              stream_position: 8,
            },
          ],
        }),
      });
      const res = await request(
        env,
        `/_matrix/client/v3/keys/changes?from=${w.from}&to=${w.to}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        changed: w.expectChanged,
        left: w.expectLeft,
      });
    });
  }
});
