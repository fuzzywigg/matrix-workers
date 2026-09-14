/**
 * TOKENMAXX HEAVY device-list-sync deepen — sliding-sync e2ee device_lists.
 * Existing module: src/api/sliding-sync.ts e2ee extension. Tests-only.
 * Covers added deltas, stale positions, empty initial maps, left:[], MSC3575+MSC4186.
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

vi.mock('../src/services/push-rule-evaluator', () => ({
  countNotificationsWithRules: vi.fn(async () => ({
    notification_count: 0,
    highlight_count: 0,
  })),
  evaluatePushRules: vi.fn(),
}));

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingForRooms: vi.fn(async (_env: unknown, roomIds: string[]) => {
      const out: Record<string, string[]> = {};
      for (const id of roomIds) out[id] = [];
      return out;
    }),
  };
});

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRooms: vi.fn(async (_env: unknown, roomIds: string[]) => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const id of roomIds) out[id] = {};
      return out;
    }),
  };
});

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: vi.fn(async () => ({ events: [], nextBatch: '0' })),
  };
});

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getE2EEAccountDataFromDO: vi.fn(async () => ({})),
  };
});

import slidingSyncApp from '../src/api/sliding-sync';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE = 'DEVICEA';

const MSC3575 = '/_matrix/client/unstable/org.matrix.msc3575/sync';
const MSC4186 = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';
const V4 = '/_matrix/client/v4/sync';

type DeviceKeyChange = { user_id: string; stream_position: number };
type SqlCall = { sql: string; args: unknown[] };

function mockKv() {
  const data: Record<string, string> = {};
  return {
    get: async () => null,
    put: async (k: string, v: string) => {
      data[k] = v;
    },
    delete: async (k: string) => {
      delete data[k];
    },
  } as unknown as KVNamespace;
}

function createSyncDoStub() {
  return {
    async fetch(): Promise<Response> {
      return Response.json({ hasEvents: false });
    },
  };
}

function createUserKeysStub(opts: {
  deviceIds?: string[];
  crossSigning?: Record<string, unknown>;
  failList?: boolean;
} = {}) {
  const deviceIds = opts.deviceIds ?? [];
  const crossSigning = opts.crossSigning ?? {};
  return {
    async fetch(req: Request): Promise<Response> {
      if (opts.failList && req.url.includes('/device-keys/list')) {
        throw new Error('device-keys list boom');
      }
      if (req.url.includes('/device-keys/list')) {
        return Response.json(deviceIds);
      }
      if (req.url.includes('/cross-signing/get')) {
        return Response.json(crossSigning);
      }
      return Response.json({});
    },
  };
}

function createSlidingDb(opts: {
  maxStreamPos?: number | null;
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
  otkCounts?: Array<{ algorithm: string; count: number }>;
  fallbackAlgos?: Array<{ algorithm: string }>;
} = {}) {
  const maxStreamPos = opts.maxStreamPos === undefined ? 42 : opts.maxStreamPos;
  const deviceKeyChanges = opts.deviceKeyChanges ?? [];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const otkCounts = opts.otkCounts ?? [];
  const fallbackAlgos = opts.fallbackAlgos ?? [];
  const selects: SqlCall[] = [];

  function handleAll(sql: string, args: unknown[]): unknown[] {
    if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
      return otkCounts;
    }
    if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
      return fallbackAlgos;
    }
    if (
      sql.includes('FROM device_key_changes dkc') &&
      sql.includes('SELECT DISTINCT dkc.user_id')
    ) {
      const [sincePos] = args as [number, string, string];
      const users = [
        ...new Set(
          deviceKeyChanges
            .filter(
              (c) =>
                c.stream_position > sincePos &&
                (c.user_id === USER || sharedRoomUsers.has(c.user_id))
            )
            .map((c) => c.user_id)
        ),
      ];
      return users.map((user_id) => ({ user_id }));
    }
    // Empty membership/list queries for e2ee-only posts
    return [];
  }

  const db = {
    selects,
    prepare(sql: string) {
      const makeStmt = (args: unknown[] = []) => ({
        async first<T>() {
          selects.push({ sql, args });
          if (
            sql.includes('MAX(stream_ordering)') &&
            sql.includes('FROM events') &&
            !sql.includes('WHERE')
          ) {
            return { max_pos: maxStreamPos } as T;
          }
          return null as T;
        },
        async all<T>() {
          selects.push({ sql, args });
          return { results: handleAll(sql, args) as T[] };
        },
        async run() {
          return { success: true };
        },
      });
      return {
        ...makeStmt([]),
        bind(...args: unknown[]) {
          return makeStmt(args);
        },
      };
    },
    async batch(stmts: Array<{ all: () => Promise<{ results: unknown[] }> }>) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.all());
      return out;
    },
  };
  return db;
}

function createEnv(opts: {
  db?: ReturnType<typeof createSlidingDb>;
  userKeys?: ReturnType<typeof createUserKeysStub>;
} = {}) {
  const db = opts.db ?? createSlidingDb();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => createSyncDoStub(),
    },
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => `uk:${name}` }),
      get: () => userKeys,
    },
    _db: db,
  } as unknown as Env & { _db: ReturnType<typeof createSlidingDb> };
}

async function postSync(path: string, env: Env, body: unknown) {
  const res = await slidingSyncApp.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { _raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function e2eeLists(body: Record<string, unknown>): { changed: string[]; left: string[] } {
  const ext = body.extensions as { e2ee?: { device_lists?: { changed: string[]; left: string[] } } };
  return ext.e2ee?.device_lists ?? { changed: [], left: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const PATHS = [
  ['MSC3575', MSC3575],
  ['MSC4186', MSC4186],
  ['v4', V4],
] as const;

// ---------------------------------------------------------------------------
// Added deltas (pos > 0)
// ---------------------------------------------------------------------------

describe.each(PATHS)('%s sliding e2ee — added deltas', (_label, path) => {
  it('lists shared peers whose keys changed after pos', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 20 },
          { user_id: CAROL, stream_position: 5 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { status, body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: { enabled: true } },
    });
    expect(status).toBe(200);
    const lists = e2eeLists(body);
    expect(lists.changed).toContain(BOB);
    expect(lists.changed).not.toContain(CAROL);
    expect(lists.left).toEqual([]);
  });

  it('includes self when own keys changed after pos', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: USER, stream_position: 25 },
          { user_id: BOB, stream_position: 30 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: {} },
    });
    const lists = e2eeLists(body);
    expect(lists.changed).toEqual(expect.arrayContaining([USER, BOB]));
    expect(lists.left).toEqual([]);
  });

  it('dedupes multiple change rows for same peer', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 11 },
          { user_id: BOB, stream_position: 12 },
          { user_id: BOB, stream_position: 13 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: { enabled: true } },
    });
    expect(e2eeLists(body).changed).toEqual([BOB]);
  });
});

// ---------------------------------------------------------------------------
// Stale positions
// ---------------------------------------------------------------------------

describe.each(PATHS)('%s sliding e2ee — stale positions', (_label, path) => {
  it('ignores changes at or before pos', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 10 },
          { user_id: USER, stream_position: 9 },
          { user_id: CAROL, stream_position: 11 },
        ],
        sharedRoomUsers: [BOB, CAROL],
      }),
    });
    const { body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: { enabled: true } },
    });
    expect(e2eeLists(body).changed).toEqual([CAROL]);
  });

  it('returns empty changed when all deltas are stale', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 3 },
          { user_id: USER, stream_position: 4 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: {} },
    });
    expect(e2eeLists(body)).toEqual({ changed: [], left: [] });
  });
});

// ---------------------------------------------------------------------------
// Empty initial device maps (pos absent / 0)
// ---------------------------------------------------------------------------

describe.each(PATHS)('%s sliding e2ee — empty / initial maps', (_label, path) => {
  it('skips self on initial sync when no device or cross-signing keys', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({ deviceIds: [], crossSigning: {} }),
    });
    const { body } = await postSync(path, env, { extensions: { e2ee: {} } });
    expect(e2eeLists(body)).toEqual({ changed: [], left: [] });
  });

  it('includes self on initial sync when device ids exist', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({ deviceIds: [DEVICE] }),
    });
    const { body } = await postSync(path, env, { extensions: { e2ee: {} } });
    expect(e2eeLists(body).changed).toEqual([USER]);
    expect(e2eeLists(body).left).toEqual([]);
  });

  it('includes self on initial sync when only cross-signing keys exist', async () => {
    const env = createEnv({
      userKeys: createUserKeysStub({
        deviceIds: [],
        crossSigning: { master_key: { keys: {} } },
      }),
    });
    const { body } = await postSync(path, env, { extensions: { e2ee: { enabled: true } } });
    expect(e2eeLists(body).changed).toContain(USER);
  });

  it('empty sharedRoomUsers yields only self when self changed', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: USER, stream_position: 20 },
          { user_id: BOB, stream_position: 20 },
        ],
        sharedRoomUsers: [],
      }),
    });
    const { body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: {} },
    });
    expect(e2eeLists(body).changed).toEqual([USER]);
  });
});

// ---------------------------------------------------------------------------
// left always empty + OTK alongside
// ---------------------------------------------------------------------------

describe.each(PATHS)('%s sliding e2ee — left + OTK co-presence', (_label, path) => {
  it('always returns left: [] even when peers changed', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [{ user_id: BOB, stream_position: 40 }],
        sharedRoomUsers: [BOB],
        otkCounts: [{ algorithm: 'signed_curve25519', count: 7 }],
        fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
      }),
    });
    const { body } = await postSync(path, env, {
      pos: '10',
      extensions: { e2ee: { enabled: true } },
    });
    const e2ee = (body.extensions as { e2ee: Record<string, unknown> }).e2ee;
    expect(e2ee.device_lists).toEqual({ changed: [BOB], left: [] });
    expect(e2ee.device_one_time_keys_count).toEqual({ signed_curve25519: 7 });
    expect(e2ee.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
});
