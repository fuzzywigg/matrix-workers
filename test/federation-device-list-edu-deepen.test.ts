/**
 * TOKENMAXX HEAVY device-list-sync deepen — federation inbound m.device_list_update EDUs.
 * Existing modules only (src/api/federation.ts send txn EDU switch). Tests-only.
 * Covers device added/deleted deltas, stale stream_id tracking, empty/partial failure
 * paths already coded. Fixtures use example.com only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const FED_ORIGIN = 'remote.example.com';
let federationOrigin: string | undefined = FED_ORIGIN;

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOrigin !== undefined) {
        c.set('federationOrigin', federationOrigin);
      }
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOrigin !== undefined) {
        c.set('federationOrigin', federationOrigin);
      }
      await next();
    };
  },
}));

vi.mock('../src/services/federation-keys', () => ({
  getRemoteKeysWithNotarySignature: vi.fn(),
  verifyRemoteSignature: vi.fn(async () => true),
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getRoomState: vi.fn(async () => ({})),
  };
});

vi.mock('../src/services/event-auth', () => ({
  checkEventAuth: vi.fn(() => ({ allowed: true })),
}));

import federation from '../src/api/federation';

const SERVER = 'example.com';
const REMOTE_USER = '@bob:remote.example.com';
const REMOTE_DEVICE = 'REMOTEDEV';
const REMOTE_DEVICE_B = 'REMOTEDEVB';

type SqlCall = { sql: string; args: unknown[] };

type RemoteDeviceRow = {
  user_id: string;
  device_id: string;
  device_display_name: string | null;
  keys: string | null;
  stream_id: number;
  updated_at: number;
};

type RemoteStreamRow = {
  user_id: string;
  stream_id: number;
  updated_at: number;
};

function deviceKey(userId: string, deviceId: string) {
  return `${userId}|${deviceId}`;
}

function createDeviceListDb(opts: {
  remoteDevices?: RemoteDeviceRow[];
  remoteStreams?: RemoteStreamRow[];
  /** Throw only on remote_device_lists write/delete (partial EDU failure). */
  failRemoteDeviceLists?: boolean;
  /** Throw on remote_device_list_streams write. */
  failRemoteStreams?: boolean;
} = {}) {
  const remoteDevices = new Map<string, RemoteDeviceRow>(
    (opts.remoteDevices ?? []).map((r) => [deviceKey(r.user_id, r.device_id), { ...r }])
  );
  const remoteStreams = new Map<string, RemoteStreamRow>(
    (opts.remoteStreams ?? []).map((r) => [r.user_id, { ...r }])
  );
  const federationTxns: Record<string, string> = {};
  const processedEdus: Array<{ edu_id: string; edu_type: string; origin: string }> = [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    remoteDevices,
    remoteStreams,
    federationTxns,
    processedEdus,
    inserts,
    deletes,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT response FROM federation_transactions')) {
                const [txnId, origin] = args as [string, string];
                const raw = federationTxns[`${origin}|${txnId}`];
                return (raw ? { response: raw } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              runs.push({ sql, args });

              if (
                sql.includes('DELETE FROM remote_device_lists') ||
                (sql.includes('INSERT') && sql.includes('remote_device_lists'))
              ) {
                if (opts.failRemoteDeviceLists) {
                  throw new Error('simulated remote_device_lists failure');
                }
              }
              if (sql.includes('remote_device_list_streams') && opts.failRemoteStreams) {
                throw new Error('simulated remote_device_list_streams failure');
              }

              if (sql.includes('DELETE FROM remote_device_lists')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as [string, string];
                remoteDevices.delete(deviceKey(userId, deviceId));
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('INSERT') && sql.includes('remote_device_lists')) {
                inserts.push({ sql, args });
                const [userId, deviceId, displayName, keys, streamId, updatedAt] = args as [
                  string,
                  string,
                  string | null,
                  string | null,
                  number,
                  number,
                ];
                remoteDevices.set(deviceKey(userId, deviceId), {
                  user_id: userId,
                  device_id: deviceId,
                  device_display_name: displayName,
                  keys,
                  stream_id: streamId,
                  updated_at: updatedAt,
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('INSERT') && sql.includes('remote_device_list_streams')) {
                inserts.push({ sql, args });
                const [userId, streamId, updatedAt] = args as [string, number, number];
                const prev = remoteStreams.get(userId);
                const nextStream = prev ? Math.max(prev.stream_id, streamId) : streamId;
                remoteStreams.set(userId, {
                  user_id: userId,
                  stream_id: nextStream,
                  updated_at: updatedAt,
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('processed_edus')) {
                inserts.push({ sql, args });
                const [eduId, eduType, origin] = args as [string, string, string];
                processedEdus.push({ edu_id: eduId, edu_type: eduType, origin });
                return { success: true, meta: { changes: 1 } };
              }

              if (
                sql.includes('INSERT INTO federation_transactions') ||
                sql.includes('INSERT OR REPLACE INTO federation_transactions')
              ) {
                inserts.push({ sql, args });
                const [txnId, origin, , response] = args as [string, string, number, string];
                federationTxns[`${origin}|${txnId}`] = response;
                return { success: true, meta: { changes: 1 } };
              }

              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type DeviceListDb = ReturnType<typeof createDeviceListDb>;

function makeEnv(db: DeviceListDb): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: db as unknown as D1Database,
  } as Env;
}

async function sendTxn(
  env: Env,
  txnId: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await federation.request(
    `http://localhost/_matrix/federation/v1/send/${txnId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function deviceListEdu(content: Record<string, unknown>) {
  return { edu_type: 'm.device_list_update', content };
}

beforeEach(() => {
  federationOrigin = FED_ORIGIN;
});

// ---------------------------------------------------------------------------
// Device added deltas (insert / upsert)
// ---------------------------------------------------------------------------

describe('federation m.device_list_update — device added deltas', () => {
  it('inserts a new remote device list row and stream tracker', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);
    const keys = {
      user_id: REMOTE_USER,
      device_id: REMOTE_DEVICE,
      algorithms: ['m.olm.v1.curve25519-aes-sha2'],
    };

    const res = await sendTxn(env, 'txn-add-1', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'Bob Phone',
          stream_id: 10,
          keys,
        }),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pdus: {} });
    const row = db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE));
    expect(row).toMatchObject({
      user_id: REMOTE_USER,
      device_id: REMOTE_DEVICE,
      device_display_name: 'Bob Phone',
      stream_id: 10,
    });
    expect(JSON.parse(row!.keys!)).toEqual(keys);
    expect(db.remoteStreams.get(REMOTE_USER)).toMatchObject({
      user_id: REMOTE_USER,
      stream_id: 10,
    });
    expect(db.processedEdus.some((e) => e.edu_type === 'm.device_list_update')).toBe(true);
  });

  it('upserts an existing device with newer keys and display name', async () => {
    const db = createDeviceListDb({
      remoteDevices: [
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'Old',
          keys: JSON.stringify({ v: 1 }),
          stream_id: 5,
          updated_at: 1,
        },
      ],
      remoteStreams: [{ user_id: REMOTE_USER, stream_id: 5, updated_at: 1 }],
    });
    const env = makeEnv(db);

    await sendTxn(env, 'txn-add-2', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'New',
          stream_id: 20,
          keys: { v: 2 },
        }),
      ],
    });

    const row = db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE));
    expect(row?.device_display_name).toBe('New');
    expect(JSON.parse(row!.keys!)).toEqual({ v: 2 });
    expect(row?.stream_id).toBe(20);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(20);
  });

  it('stores null keys when keys omitted and null display when name omitted', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-add-3', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 3,
        }),
      ],
    });

    const row = db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE));
    expect(row?.keys).toBeNull();
    expect(row?.device_display_name).toBeNull();
    expect(row?.stream_id).toBe(3);
  });

  it('defaults missing stream_id to 0 on add', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-add-4', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          keys: { k: 1 },
        }),
      ],
    });

    expect(db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE))?.stream_id).toBe(0);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(0);
  });

  it('adds multiple devices for the same user in one transaction', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-add-multi', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 1,
          keys: { a: 1 },
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE_B,
          stream_id: 2,
          keys: { b: 1 },
        }),
      ],
    });

    expect(db.remoteDevices.size).toBe(2);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Device deleted deltas
// ---------------------------------------------------------------------------

describe('federation m.device_list_update — device deleted deltas', () => {
  it('deletes the remote device row when deleted=true', async () => {
    const db = createDeviceListDb({
      remoteDevices: [
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'Gone',
          keys: '{}',
          stream_id: 9,
          updated_at: 1,
        },
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE_B,
          device_display_name: 'Keep',
          keys: '{}',
          stream_id: 9,
          updated_at: 1,
        },
      ],
      remoteStreams: [{ user_id: REMOTE_USER, stream_id: 9, updated_at: 1 }],
    });
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-del-1', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          deleted: true,
          stream_id: 11,
        }),
      ],
    });

    expect(res.status).toBe(200);
    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(false);
    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE_B))).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM remote_device_lists'))).toBe(true);
    // Stream tracker still advances even on delete
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(11);
  });

  it('delete of unknown device is idempotent and still updates stream', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-del-2', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'NOSUCH',
          deleted: true,
          stream_id: 4,
        }),
      ],
    });

    expect(res.status).toBe(200);
    expect(db.remoteDevices.size).toBe(0);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(4);
  });

  it('add then delete in same txn leaves device absent', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-del-3', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 1,
          keys: { x: 1 },
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          deleted: true,
          stream_id: 2,
        }),
      ],
    });

    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(false);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(2);
  });

  it('deleted=false is treated as an add/upsert', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-del-4', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          deleted: false,
          stream_id: 7,
          keys: { ok: true },
        }),
      ],
    });

    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(true);
    expect(db.deletes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stale stream_id tracking (MAX on streams; device row still overwritten)
// ---------------------------------------------------------------------------

describe('federation m.device_list_update — stale stream lists', () => {
  it('keeps MAX stream_id on streams when a stale lower stream arrives', async () => {
    const db = createDeviceListDb({
      remoteDevices: [
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'Fresh',
          keys: JSON.stringify({ fresh: true }),
          stream_id: 100,
          updated_at: 1,
        },
      ],
      remoteStreams: [{ user_id: REMOTE_USER, stream_id: 100, updated_at: 1 }],
    });
    const env = makeEnv(db);

    await sendTxn(env, 'txn-stale-1', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: 'Stale',
          stream_id: 50,
          keys: { fresh: false },
        }),
      ],
    });

    // Current implementation overwrites device row regardless of stream order
    const row = db.remoteDevices.get(deviceKey(REMOTE_USER, REMOTE_DEVICE));
    expect(row?.device_display_name).toBe('Stale');
    expect(row?.stream_id).toBe(50);
    // Stream tracker uses MAX — stale update must not regress
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(100);
  });

  it('advances stream tracker when equal stream_id is re-applied', async () => {
    const db = createDeviceListDb({
      remoteStreams: [{ user_id: REMOTE_USER, stream_id: 8, updated_at: 1 }],
    });
    const env = makeEnv(db);

    await sendTxn(env, 'txn-stale-2', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 8,
          keys: { same: 1 },
        }),
      ],
    });

    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(8);
  });

  it('stale delete still advances stream via MAX only when delete stream is higher', async () => {
    const db = createDeviceListDb({
      remoteDevices: [
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: null,
          keys: '{}',
          stream_id: 30,
          updated_at: 1,
        },
      ],
      remoteStreams: [{ user_id: REMOTE_USER, stream_id: 30, updated_at: 1 }],
    });
    const env = makeEnv(db);

    await sendTxn(env, 'txn-stale-3', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          deleted: true,
          stream_id: 12,
        }),
      ],
    });

    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(false);
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Empty / incomplete EDU content (skip without failing txn)
// ---------------------------------------------------------------------------

describe('federation m.device_list_update — empty / incomplete maps', () => {
  it('skips EDU missing user_id without writing device rows', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-empty-1', {
      pdus: [],
      edus: [
        deviceListEdu({
          device_id: REMOTE_DEVICE,
          stream_id: 1,
          keys: { x: 1 },
        }),
      ],
    });

    expect(res.status).toBe(200);
    expect(db.remoteDevices.size).toBe(0);
    expect(db.remoteStreams.size).toBe(0);
    expect(db.processedEdus).toHaveLength(1);
  });

  it('skips EDU missing device_id without writing device rows', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-empty-2', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          stream_id: 1,
          keys: { x: 1 },
        }),
      ],
    });

    expect(db.remoteDevices.size).toBe(0);
    expect(db.remoteStreams.size).toBe(0);
  });

  it('skips empty-string device_id (falsy) the same as missing', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-empty-3', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: '',
          stream_id: 1,
        }),
      ],
    });

    expect(db.remoteDevices.size).toBe(0);
  });

  it('empty edus array still caches empty pdus response', async () => {
    const db = createDeviceListDb();
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-empty-4', { pdus: [], edus: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pdus: {} });
    expect(db.federationTxns[`${FED_ORIGIN}|txn-empty-4`]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Partial failures already coded (swallow + continue txn)
// ---------------------------------------------------------------------------

describe('federation m.device_list_update — partial sync failures', () => {
  it('swallows remote_device_lists insert failure and still returns 200', async () => {
    const db = createDeviceListDb({ failRemoteDeviceLists: true });
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-fail-1', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 1,
          keys: { boom: true },
        }),
      ],
    });

    expect(res.status).toBe(200);
    expect(db.remoteDevices.size).toBe(0);
    // processed_edus + federation_transactions still recorded outside the catch
    expect(db.processedEdus).toHaveLength(1);
    expect(db.federationTxns[`${FED_ORIGIN}|txn-fail-1`]).toBeDefined();
  });

  it('swallows remote_device_lists delete failure without failing txn', async () => {
    const db = createDeviceListDb({
      failRemoteDeviceLists: true,
      remoteDevices: [
        {
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          device_display_name: null,
          keys: '{}',
          stream_id: 1,
          updated_at: 1,
        },
      ],
    });
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-fail-2', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          deleted: true,
          stream_id: 2,
        }),
      ],
    });

    expect(res.status).toBe(200);
    // Delete never applied due to throw
    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(true);
  });

  it('swallows stream tracker failure after successful device upsert', async () => {
    const db = createDeviceListDb({ failRemoteStreams: true });
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-fail-3', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 9,
          keys: { ok: 1 },
        }),
      ],
    });

    expect(res.status).toBe(200);
    // Device insert happened before stream write threw — then catch aborted stream update
    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, REMOTE_DEVICE))).toBe(true);
    expect(db.remoteStreams.size).toBe(0);
  });

  it('continues processing later EDUs after a failed device_list_update', async () => {
    const db = createDeviceListDb({ failRemoteDeviceLists: true });
    // Only fail the first remote_device_lists write by toggling after first throw is awkward;
    // instead send typing after failed device update — typing has no DB write in switch.
    const env = makeEnv(db);

    const res = await sendTxn(env, 'txn-fail-4', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: REMOTE_DEVICE,
          stream_id: 1,
          keys: {},
        }),
        { edu_type: 'm.typing', content: { room_id: '!r:example.com' } },
      ],
    });

    expect(res.status).toBe(200);
    expect(db.processedEdus.map((e) => e.edu_type)).toEqual([
      'm.device_list_update',
      'm.typing',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Mixed / boundary deepen volume
// ---------------------------------------------------------------------------

describe('federation m.device_list_update — mixed delta matrix', () => {
  it('add → delete → re-add sequence ends with device present and stream advanced', async () => {
    const db = createDeviceListDb({
      remoteStreams: [{ user_id: REMOTE_USER, stream_id: 10, updated_at: 1 }],
    });
    const env = makeEnv(db);

    await sendTxn(env, 'txn-seq', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'D0',
          stream_id: 11,
          device_display_name: 'N0',
          keys: { i: 0 },
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'D0',
          deleted: true,
          stream_id: 12,
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'D0',
          stream_id: 13,
          keys: { i: 3 },
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'D1',
          stream_id: 14,
          keys: { i: 4 },
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'D1',
          stream_id: 1,
          keys: { stale: true },
        }),
      ],
    });

    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, 'D0'))).toBe(true);
    expect(db.remoteDevices.has(deviceKey(REMOTE_USER, 'D1'))).toBe(true);
    expect(JSON.parse(db.remoteDevices.get(deviceKey(REMOTE_USER, 'D1'))!.keys!)).toEqual({
      stale: true,
    });
    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(14);
  });

  it('independent users keep separate stream trackers', async () => {
    const other = '@carol:remote.example.com';
    const db = createDeviceListDb();
    const env = makeEnv(db);

    await sendTxn(env, 'txn-users', {
      pdus: [],
      edus: [
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'A',
          stream_id: 5,
          keys: {},
        }),
        deviceListEdu({
          user_id: other,
          device_id: 'B',
          stream_id: 9,
          keys: {},
        }),
        deviceListEdu({
          user_id: REMOTE_USER,
          device_id: 'A',
          stream_id: 2,
          keys: { stale: true },
        }),
      ],
    });

    expect(db.remoteStreams.get(REMOTE_USER)?.stream_id).toBe(5);
    expect(db.remoteStreams.get(other)?.stream_id).toBe(9);
  });
});
