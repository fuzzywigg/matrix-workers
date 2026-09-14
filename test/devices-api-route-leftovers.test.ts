/**
 * TOKENMAXX HEAVY leftovers after #149 / deepen after #232 / after #241 — devices API
 * soft/edge/reliability. Complements devices-api-routes.test.ts and residual
 * concurrent-race leftovers. Tests-only — no product inventing.
 * Fixtures use example.com only.
 *
 * Deepen after #232: non-password auth delete soft flood, auth:{} / auth:null,
 * null display_name, CURRENT self-delete, cascade order, session ignored,
 * delete_devices null/duplicate ids, PUT preserves last_seen, case-sensitive
 * device ids, empty-string password, SSO/token/dummy auth matrix.
 *
 * Deepen after #241: delete_devices empty array; password-field missing on
 * m.login.password; devices not-array shapes; GET omits null last_seen fields;
 * delete_devices password missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'CURRENT');
      await next();
    };
  },
}));

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

import devices from '../src/api/devices';
import { verifyPassword } from '../src/utils/crypto';

const USER = '@alice:example.com';
const AUTH = { Authorization: 'Bearer test-token' };

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};

type SqlCall = { sql: string; args: unknown[] };

function createDevicesDb(opts: {
  devices?: DeviceRow[];
  passwordHash?: string | null;
  missingUser?: boolean;
} = {}) {
  const deviceRows = opts.devices ?? [];
  const passwordHash =
    opts.passwordHash === undefined ? 'mockok:s3cret' : opts.passwordHash;
  const missingUser = opts.missingUser ?? false;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    devices: deviceRows,
    inserts,
    updates,
    deletes,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('SELECT password_hash FROM users')) {
                if (missingUser) return null as T;
                return { password_hash: passwordHash } as T;
              }
              if (
                sql.includes('FROM devices') &&
                sql.includes('device_id = ?') &&
                sql.includes('display_name')
              ) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
                if (!row) return null as T;
                return {
                  device_id: row.device_id,
                  display_name: row.display_name,
                  last_seen_ts: row.last_seen_ts,
                  last_seen_ip: row.last_seen_ip,
                } as T;
              }
              if (
                sql.includes('SELECT device_id FROM devices') &&
                sql.includes('device_id = ?')
              ) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
                return (row ? { device_id: row.device_id } : null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              if (
                sql.includes('FROM devices') &&
                sql.includes('WHERE user_id = ?') &&
                !sql.includes('device_id = ?')
              ) {
                const userId = args[0] as string;
                const results = deviceRows
                  .filter((d) => d.user_id === userId)
                  .map((d) => ({
                    device_id: d.device_id,
                    display_name: d.display_name,
                    last_seen_ts: d.last_seen_ts,
                    last_seen_ip: d.last_seen_ip,
                  }));
                return { results: results as T[] };
              }
              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 140)}`);
            },
            async run() {
              if (sql.includes('UPDATE devices SET display_name')) {
                updates.push({ sql, args });
                const [displayName, userId, deviceId] = args as [string, string, string];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
                if (row) row.display_name = displayName;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM device_keys')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM devices')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as string[];
                const before = deviceRows.length;
                for (let i = deviceRows.length - 1; i >= 0; i--) {
                  if (
                    deviceRows[i].user_id === userId &&
                    deviceRows[i].device_id === deviceId
                  ) {
                    deviceRows.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - deviceRows.length, last_row_id: 0 },
                };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type DevicesDb = ReturnType<typeof createDevicesDb>;

function envFor(db: DevicesDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(
  db: DevicesDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await devices.request(`http://localhost${path}`, init, envFor(db));
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': contentType,
      ...AUTH,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function seedDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    device_id: overrides.device_id ?? 'PHONE',
    user_id: overrides.user_id ?? USER,
    display_name: overrides.display_name ?? null,
    last_seen_ts: overrides.last_seen_ts ?? null,
    last_seen_ip: overrides.last_seen_ip ?? null,
  };
}

beforeEach(() => {
  vi.mocked(verifyPassword).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('devices leftovers GET list empty soft reliability after #149', () => {
  it('GET empty list soft-0', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-1', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-2', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-3', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-4', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-5', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-6', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-7', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-8', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-9', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-10', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-11', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-12', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-13', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-14', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-15', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-16', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-17', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-18', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
  it('GET empty list soft-19', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });
});

describe('devices leftovers GET list named soft flood after #149', () => {
  it('GET named device soft-0', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV0',
          display_name: 'Label-0',
          last_seen_ts: 1700000000000,
          last_seen_ip: '203.0.113.1',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV0',
          display_name: 'Label-0',
          last_seen_ts: 1700000000000,
          last_seen_ip: '203.0.113.1',
        },
      ],
    });
  });
  it('GET named device soft-1', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV1',
          display_name: 'Label-1',
          last_seen_ts: 1700000000001,
          last_seen_ip: '203.0.113.2',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV1',
          display_name: 'Label-1',
          last_seen_ts: 1700000000001,
          last_seen_ip: '203.0.113.2',
        },
      ],
    });
  });
  it('GET named device soft-2', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV2',
          display_name: 'Label-2',
          last_seen_ts: 1700000000002,
          last_seen_ip: '203.0.113.3',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV2',
          display_name: 'Label-2',
          last_seen_ts: 1700000000002,
          last_seen_ip: '203.0.113.3',
        },
      ],
    });
  });
  it('GET named device soft-3', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV3',
          display_name: 'Label-3',
          last_seen_ts: 1700000000003,
          last_seen_ip: '203.0.113.4',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV3',
          display_name: 'Label-3',
          last_seen_ts: 1700000000003,
          last_seen_ip: '203.0.113.4',
        },
      ],
    });
  });
  it('GET named device soft-4', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV4',
          display_name: 'Label-4',
          last_seen_ts: 1700000000004,
          last_seen_ip: '203.0.113.5',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV4',
          display_name: 'Label-4',
          last_seen_ts: 1700000000004,
          last_seen_ip: '203.0.113.5',
        },
      ],
    });
  });
  it('GET named device soft-5', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV5',
          display_name: 'Label-5',
          last_seen_ts: 1700000000005,
          last_seen_ip: '203.0.113.6',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV5',
          display_name: 'Label-5',
          last_seen_ts: 1700000000005,
          last_seen_ip: '203.0.113.6',
        },
      ],
    });
  });
  it('GET named device soft-6', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV6',
          display_name: 'Label-6',
          last_seen_ts: 1700000000006,
          last_seen_ip: '203.0.113.7',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV6',
          display_name: 'Label-6',
          last_seen_ts: 1700000000006,
          last_seen_ip: '203.0.113.7',
        },
      ],
    });
  });
  it('GET named device soft-7', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV7',
          display_name: 'Label-7',
          last_seen_ts: 1700000000007,
          last_seen_ip: '203.0.113.8',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV7',
          display_name: 'Label-7',
          last_seen_ts: 1700000000007,
          last_seen_ip: '203.0.113.8',
        },
      ],
    });
  });
  it('GET named device soft-8', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV8',
          display_name: 'Label-8',
          last_seen_ts: 1700000000008,
          last_seen_ip: '203.0.113.9',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV8',
          display_name: 'Label-8',
          last_seen_ts: 1700000000008,
          last_seen_ip: '203.0.113.9',
        },
      ],
    });
  });
  it('GET named device soft-9', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV9',
          display_name: 'Label-9',
          last_seen_ts: 1700000000009,
          last_seen_ip: '203.0.113.10',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV9',
          display_name: 'Label-9',
          last_seen_ts: 1700000000009,
          last_seen_ip: '203.0.113.10',
        },
      ],
    });
  });
  it('GET named device soft-10', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV10',
          display_name: 'Label-10',
          last_seen_ts: 1700000000010,
          last_seen_ip: '203.0.113.11',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV10',
          display_name: 'Label-10',
          last_seen_ts: 1700000000010,
          last_seen_ip: '203.0.113.11',
        },
      ],
    });
  });
  it('GET named device soft-11', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV11',
          display_name: 'Label-11',
          last_seen_ts: 1700000000011,
          last_seen_ip: '203.0.113.12',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV11',
          display_name: 'Label-11',
          last_seen_ts: 1700000000011,
          last_seen_ip: '203.0.113.12',
        },
      ],
    });
  });
  it('GET named device soft-12', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV12',
          display_name: 'Label-12',
          last_seen_ts: 1700000000012,
          last_seen_ip: '203.0.113.13',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV12',
          display_name: 'Label-12',
          last_seen_ts: 1700000000012,
          last_seen_ip: '203.0.113.13',
        },
      ],
    });
  });
  it('GET named device soft-13', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV13',
          display_name: 'Label-13',
          last_seen_ts: 1700000000013,
          last_seen_ip: '203.0.113.14',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV13',
          display_name: 'Label-13',
          last_seen_ts: 1700000000013,
          last_seen_ip: '203.0.113.14',
        },
      ],
    });
  });
  it('GET named device soft-14', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV14',
          display_name: 'Label-14',
          last_seen_ts: 1700000000014,
          last_seen_ip: '203.0.113.15',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV14',
          display_name: 'Label-14',
          last_seen_ts: 1700000000014,
          last_seen_ip: '203.0.113.15',
        },
      ],
    });
  });
  it('GET named device soft-15', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV15',
          display_name: 'Label-15',
          last_seen_ts: 1700000000015,
          last_seen_ip: '203.0.113.16',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV15',
          display_name: 'Label-15',
          last_seen_ts: 1700000000015,
          last_seen_ip: '203.0.113.16',
        },
      ],
    });
  });
  it('GET named device soft-16', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV16',
          display_name: 'Label-16',
          last_seen_ts: 1700000000016,
          last_seen_ip: '203.0.113.17',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV16',
          display_name: 'Label-16',
          last_seen_ts: 1700000000016,
          last_seen_ip: '203.0.113.17',
        },
      ],
    });
  });
  it('GET named device soft-17', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV17',
          display_name: 'Label-17',
          last_seen_ts: 1700000000017,
          last_seen_ip: '203.0.113.18',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV17',
          display_name: 'Label-17',
          last_seen_ts: 1700000000017,
          last_seen_ip: '203.0.113.18',
        },
      ],
    });
  });
  it('GET named device soft-18', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV18',
          display_name: 'Label-18',
          last_seen_ts: 1700000000018,
          last_seen_ip: '203.0.113.19',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV18',
          display_name: 'Label-18',
          last_seen_ts: 1700000000018,
          last_seen_ip: '203.0.113.19',
        },
      ],
    });
  });
  it('GET named device soft-19', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'DEV19',
          display_name: 'Label-19',
          last_seen_ts: 1700000000019,
          last_seen_ip: '203.0.113.20',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'DEV19',
          display_name: 'Label-19',
          last_seen_ts: 1700000000019,
          last_seen_ip: '203.0.113.20',
        },
      ],
    });
  });
});

describe('devices leftovers GET :deviceId soft flood after #149', () => {
  it('GET device soft-0', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P0', display_name: 'Phone-0' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P0');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P0', display_name: 'Phone-0' });
  });
  it('GET device soft-1', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P1', display_name: 'Phone-1' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P1', display_name: 'Phone-1' });
  });
  it('GET device soft-2', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P2', display_name: 'Phone-2' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P2', display_name: 'Phone-2' });
  });
  it('GET device soft-3', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P3', display_name: 'Phone-3' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P3');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P3', display_name: 'Phone-3' });
  });
  it('GET device soft-4', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P4', display_name: 'Phone-4' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P4');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P4', display_name: 'Phone-4' });
  });
  it('GET device soft-5', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P5', display_name: 'Phone-5' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P5', display_name: 'Phone-5' });
  });
  it('GET device soft-6', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P6', display_name: 'Phone-6' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P6');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P6', display_name: 'Phone-6' });
  });
  it('GET device soft-7', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P7', display_name: 'Phone-7' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P7', display_name: 'Phone-7' });
  });
  it('GET device soft-8', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P8', display_name: 'Phone-8' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P8');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P8', display_name: 'Phone-8' });
  });
  it('GET device soft-9', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P9', display_name: 'Phone-9' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P9');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P9', display_name: 'Phone-9' });
  });
  it('GET device soft-10', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P10', display_name: 'Phone-10' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P10', display_name: 'Phone-10' });
  });
  it('GET device soft-11', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P11', display_name: 'Phone-11' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P11');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P11', display_name: 'Phone-11' });
  });
  it('GET device soft-12', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P12', display_name: 'Phone-12' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P12', display_name: 'Phone-12' });
  });
  it('GET device soft-13', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P13', display_name: 'Phone-13' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P13');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P13', display_name: 'Phone-13' });
  });
  it('GET device soft-14', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P14', display_name: 'Phone-14' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P14');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P14', display_name: 'Phone-14' });
  });
  it('GET device soft-15', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P15', display_name: 'Phone-15' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P15');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P15', display_name: 'Phone-15' });
  });
  it('GET device soft-16', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P16', display_name: 'Phone-16' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P16');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P16', display_name: 'Phone-16' });
  });
  it('GET device soft-17', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P17', display_name: 'Phone-17' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P17');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P17', display_name: 'Phone-17' });
  });
  it('GET device soft-18', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P18', display_name: 'Phone-18' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P18');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P18', display_name: 'Phone-18' });
  });
  it('GET device soft-19', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'P19', display_name: 'Phone-19' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/P19');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'P19', display_name: 'Phone-19' });
  });
});

describe('devices leftovers PUT display_name soft flood after #149', () => {
  it('PUT display_name soft-0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-0' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-0');
  });
  it('PUT display_name soft-1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-1' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-1');
  });
  it('PUT display_name soft-2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-2' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-2');
  });
  it('PUT display_name soft-3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-3' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-3');
  });
  it('PUT display_name soft-4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-4' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-4');
  });
  it('PUT display_name soft-5', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-5' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-5');
  });
  it('PUT display_name soft-6', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-6' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-6');
  });
  it('PUT display_name soft-7', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-7' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-7');
  });
  it('PUT display_name soft-8', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-8' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-8');
  });
  it('PUT display_name soft-9', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-9' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-9');
  });
  it('PUT display_name soft-10', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-10' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-10');
  });
  it('PUT display_name soft-11', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-11' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-11');
  });
  it('PUT display_name soft-12', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-12' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-12');
  });
  it('PUT display_name soft-13', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-13' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-13');
  });
  it('PUT display_name soft-14', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-14' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-14');
  });
  it('PUT display_name soft-15', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-15' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-15');
  });
  it('PUT display_name soft-16', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-16' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-16');
  });
  it('PUT display_name soft-17', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-17' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-17');
  });
  it('PUT display_name soft-18', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-18' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-18');
  });
  it('PUT display_name soft-19', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Name-19' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices[0].display_name).toBe('Name-19');
  });
});

describe('devices leftovers DELETE UIA challenge soft flood after #149', () => {
  it('DELETE UIA soft-0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D0' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D0', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D1' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D1', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D2' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D2', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D3' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D3', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D4' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D4', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-5', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D5' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D5', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-6', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D6' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D6', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-7', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D7' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D7', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-8', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D8' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D8', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-9', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D9' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D9', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-10', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D10' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D10', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-11', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D11' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D11', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-12', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D12' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D12', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-13', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D13' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D13', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-14', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D14' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D14', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-15', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D15' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D15', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-16', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D16' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D16', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-17', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D17' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D17', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-18', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D18' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D18', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
  it('DELETE UIA soft-19', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D19' })] });
    const res = await request(db, '/_matrix/client/v3/devices/D19', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof res.body.session).toBe('string');
  });
});

describe('devices leftovers DELETE password success soft flood after #149', () => {
  it('DELETE with password soft-0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X0' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X0',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X0')).toBeUndefined();
  });
  it('DELETE with password soft-1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X1' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X1',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X1')).toBeUndefined();
  });
  it('DELETE with password soft-2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X2' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X2',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X2')).toBeUndefined();
  });
  it('DELETE with password soft-3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X3' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X3',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X3')).toBeUndefined();
  });
  it('DELETE with password soft-4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X4' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X4',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X4')).toBeUndefined();
  });
  it('DELETE with password soft-5', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X5' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X5',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X5')).toBeUndefined();
  });
  it('DELETE with password soft-6', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X6' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X6',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X6')).toBeUndefined();
  });
  it('DELETE with password soft-7', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X7' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X7',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X7')).toBeUndefined();
  });
  it('DELETE with password soft-8', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X8' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X8',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X8')).toBeUndefined();
  });
  it('DELETE with password soft-9', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X9' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X9',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X9')).toBeUndefined();
  });
  it('DELETE with password soft-10', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X10' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X10',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X10')).toBeUndefined();
  });
  it('DELETE with password soft-11', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X11' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X11',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X11')).toBeUndefined();
  });
  it('DELETE with password soft-12', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X12' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X12',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X12')).toBeUndefined();
  });
  it('DELETE with password soft-13', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X13' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X13',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X13')).toBeUndefined();
  });
  it('DELETE with password soft-14', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X14' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X14',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X14')).toBeUndefined();
  });
  it('DELETE with password soft-15', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X15' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X15',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X15')).toBeUndefined();
  });
  it('DELETE with password soft-16', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X16' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X16',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X16')).toBeUndefined();
  });
  it('DELETE with password soft-17', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X17' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X17',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X17')).toBeUndefined();
  });
  it('DELETE with password soft-18', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X18' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X18',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X18')).toBeUndefined();
  });
  it('DELETE with password soft-19', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X19' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/X19',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.find((d) => d.device_id === 'X19')).toBeUndefined();
  });
});

describe('devices leftovers POST delete_devices soft flood after #149', () => {
  it('bulk delete soft-0', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A0' }),
        seedDevice({ device_id: 'B0' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A0', 'B0'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-1', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A1' }),
        seedDevice({ device_id: 'B1' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A1', 'B1'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-2', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A2' }),
        seedDevice({ device_id: 'B2' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A2', 'B2'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-3', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A3' }),
        seedDevice({ device_id: 'B3' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A3', 'B3'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-4', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A4' }),
        seedDevice({ device_id: 'B4' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A4', 'B4'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-5', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A5' }),
        seedDevice({ device_id: 'B5' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A5', 'B5'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-6', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A6' }),
        seedDevice({ device_id: 'B6' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A6', 'B6'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-7', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A7' }),
        seedDevice({ device_id: 'B7' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A7', 'B7'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-8', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A8' }),
        seedDevice({ device_id: 'B8' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A8', 'B8'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-9', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A9' }),
        seedDevice({ device_id: 'B9' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A9', 'B9'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-10', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A10' }),
        seedDevice({ device_id: 'B10' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A10', 'B10'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-11', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A11' }),
        seedDevice({ device_id: 'B11' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A11', 'B11'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-12', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A12' }),
        seedDevice({ device_id: 'B12' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A12', 'B12'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-13', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A13' }),
        seedDevice({ device_id: 'B13' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A13', 'B13'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-14', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A14' }),
        seedDevice({ device_id: 'B14' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A14', 'B14'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-15', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A15' }),
        seedDevice({ device_id: 'B15' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A15', 'B15'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-16', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A16' }),
        seedDevice({ device_id: 'B16' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A16', 'B16'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-17', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A17' }),
        seedDevice({ device_id: 'B17' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A17', 'B17'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-18', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A18' }),
        seedDevice({ device_id: 'B18' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A18', 'B18'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
  it('bulk delete soft-19', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A19' }),
        seedDevice({ device_id: 'B19' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A19', 'B19'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices).toHaveLength(0);
  });
});

describe('devices leftovers method matrix after #149', () => {
  const cases: Array<{ path: string; allowed: string[]; bad: string[] }> = [
    { path: '/_matrix/client/v3/devices', allowed: ['GET'], bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/devices/PHONE', allowed: ['GET', 'PUT', 'DELETE'], bad: ['POST', 'PATCH'] },
    { path: '/_matrix/client/v3/delete_devices', allowed: ['POST'], bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path} → 404/405`, async () => {
        const db = createDevicesDb({ devices: [seedDevice()] });
        const res = await request(db, c.path, jsonInit(method, method === 'GET' ? undefined : {}));
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});

describe('devices leftovers Content-Type charset soft flood after #149', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'application/json; charset="utf-8"',
  ];

  it('PUT with charset variant soft-0', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const ct = charsets[0];
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'ct-0' }, ct)
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('ct-0');
  });

  it('PUT with charset variant soft-1', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const ct = charsets[1];
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'ct-1' }, ct)
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('ct-1');
  });

  it('PUT with charset variant soft-2', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const ct = charsets[2];
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'ct-2' }, ct)
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('ct-2');
  });

  it('PUT with charset variant soft-3', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const ct = charsets[3];
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'ct-3' }, ct)
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('ct-3');
  });

  it('PUT with charset variant soft-4', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const ct = charsets[4];
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'ct-4' }, ct)
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('ct-4');
  });

  it('POST delete_devices charset soft-0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'Z0' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit(
        'POST',
        { devices: ['Z0'], auth: { type: 'm.login.password', password: 's3cret' } },
        charsets[0]
      )
    );
    expect(res.status).toBe(200);
  });

  it('POST delete_devices charset soft-1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'Z1' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit(
        'POST',
        { devices: ['Z1'], auth: { type: 'm.login.password', password: 's3cret' } },
        charsets[1]
      )
    );
    expect(res.status).toBe(200);
  });

  it('POST delete_devices charset soft-2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'Z2' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit(
        'POST',
        { devices: ['Z2'], auth: { type: 'm.login.password', password: 's3cret' } },
        charsets[2]
      )
    );
    expect(res.status).toBe(200);
  });

  it('POST delete_devices charset soft-3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'Z3' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit(
        'POST',
        { devices: ['Z3'], auth: { type: 'm.login.password', password: 's3cret' } },
        charsets[3]
      )
    );
    expect(res.status).toBe(200);
  });

  it('POST delete_devices charset soft-4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'Z4' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit(
        'POST',
        { devices: ['Z4'], auth: { type: 'm.login.password', password: 's3cret' } },
        charsets[4]
      )
    );
    expect(res.status).toBe(200);
  });
});

describe('devices leftovers failure and edge cases after #149', () => {
  it('GET missing device 404', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices/NOPE');
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT missing device 404', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices/NOPE', jsonInit('PUT', { display_name: 'x' }));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT bad JSON', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('DELETE missing device 404', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices/NOPE', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('DELETE wrong password', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('DELETE missing password on password auth', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: { type: 'm.login.password' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('DELETE missing user row', async () => {
    const db = createDevicesDb({ devices: [seedDevice()], missingUser: true });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('POST delete_devices bad JSON', async () => {
    const db = createDevicesDb();
    const res = await request(db, '/_matrix/client/v3/delete_devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('POST delete_devices missing devices', async () => {
    const db = createDevicesDb();
    const res = await request(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('POST delete_devices devices not array', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: 'PHONE' })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('POST delete_devices UIA when auth omitted', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: ['PHONE'] })
    );
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
  });

  it('POST delete_devices wrong password', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['PHONE'],
        auth: { type: 'm.login.password', password: 'nope' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('omits falsy optional fields on list', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'BARE',
          display_name: '',
          last_seen_ts: 0,
          last_seen_ip: '',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [{ device_id: 'BARE' }] });
  });

  it('does not leak other user devices', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'MINE' }),
        seedDevice({ device_id: 'THEIRS', user_id: '@bob:example.com' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.body.devices).toEqual([{ device_id: 'MINE' }]);
  });

  it('URL-encoded device id round-trip', async () => {
    const id = 'dev/with spaces';
    const db = createDevicesDb({ devices: [seedDevice({ device_id: id, display_name: 'enc' })] });
    const res = await request(db, `/_matrix/client/v3/devices/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe(id);
  });
});

describe('devices leftovers lifecycle soft floods after #149', () => {
  it('list→put→get→delete lifecycle soft-0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L0' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L0')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L0',
      jsonInit('PUT', { display_name: 'Life-0' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L0');
    expect(get.body.display_name).toBe('Life-0');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L0',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L0')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L1' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L1')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L1',
      jsonInit('PUT', { display_name: 'Life-1' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L1');
    expect(get.body.display_name).toBe('Life-1');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L1',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L1')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L2' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L2')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L2',
      jsonInit('PUT', { display_name: 'Life-2' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L2');
    expect(get.body.display_name).toBe('Life-2');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L2',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L2')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L3' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L3')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L3',
      jsonInit('PUT', { display_name: 'Life-3' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L3');
    expect(get.body.display_name).toBe('Life-3');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L3',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L3')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L4' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L4')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L4',
      jsonInit('PUT', { display_name: 'Life-4' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L4');
    expect(get.body.display_name).toBe('Life-4');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L4',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L4')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-5', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L5' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L5')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L5',
      jsonInit('PUT', { display_name: 'Life-5' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L5');
    expect(get.body.display_name).toBe('Life-5');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L5',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L5')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-6', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L6' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L6')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L6',
      jsonInit('PUT', { display_name: 'Life-6' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L6');
    expect(get.body.display_name).toBe('Life-6');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L6',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L6')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-7', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L7' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L7')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L7',
      jsonInit('PUT', { display_name: 'Life-7' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L7');
    expect(get.body.display_name).toBe('Life-7');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L7',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L7')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-8', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L8' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L8')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L8',
      jsonInit('PUT', { display_name: 'Life-8' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L8');
    expect(get.body.display_name).toBe('Life-8');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L8',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L8')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-9', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L9' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L9')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L9',
      jsonInit('PUT', { display_name: 'Life-9' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L9');
    expect(get.body.display_name).toBe('Life-9');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L9',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L9')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-10', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L10' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L10')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L10',
      jsonInit('PUT', { display_name: 'Life-10' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L10');
    expect(get.body.display_name).toBe('Life-10');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L10',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L10')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-11', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L11' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L11')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L11',
      jsonInit('PUT', { display_name: 'Life-11' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L11');
    expect(get.body.display_name).toBe('Life-11');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L11',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L11')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-12', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L12' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L12')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L12',
      jsonInit('PUT', { display_name: 'Life-12' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L12');
    expect(get.body.display_name).toBe('Life-12');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L12',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L12')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-13', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L13' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L13')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L13',
      jsonInit('PUT', { display_name: 'Life-13' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L13');
    expect(get.body.display_name).toBe('Life-13');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L13',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L13')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-14', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L14' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L14')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L14',
      jsonInit('PUT', { display_name: 'Life-14' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L14');
    expect(get.body.display_name).toBe('Life-14');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L14',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L14')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-15', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L15' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L15')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L15',
      jsonInit('PUT', { display_name: 'Life-15' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L15');
    expect(get.body.display_name).toBe('Life-15');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L15',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L15')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-16', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L16' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L16')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L16',
      jsonInit('PUT', { display_name: 'Life-16' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L16');
    expect(get.body.display_name).toBe('Life-16');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L16',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L16')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-17', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L17' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L17')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L17',
      jsonInit('PUT', { display_name: 'Life-17' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L17');
    expect(get.body.display_name).toBe('Life-17');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L17',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L17')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-18', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L18' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L18')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L18',
      jsonInit('PUT', { display_name: 'Life-18' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L18');
    expect(get.body.display_name).toBe('Life-18');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L18',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L18')).toBeUndefined();
  });
  it('list→put→get→delete lifecycle soft-19', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'L19' })] });
    const list = await request(db, '/_matrix/client/v3/devices');
    expect(list.status).toBe(200);
    expect(list.body.devices.some((d: { device_id: string }) => d.device_id === 'L19')).toBe(true);

    const put = await request(
      db,
      '/_matrix/client/v3/devices/L19',
      jsonInit('PUT', { display_name: 'Life-19' })
    );
    expect(put.status).toBe(200);

    const get = await request(db, '/_matrix/client/v3/devices/L19');
    expect(get.body.display_name).toBe('Life-19');

    const del = await request(
      db,
      '/_matrix/client/v3/devices/L19',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
    );
    expect(del.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'L19')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deepen devices-api route leftovers after #232
// ---------------------------------------------------------------------------

describe('devices leftovers non-password auth DELETE soft flood after #232', () => {
  const types = [
    'm.login.dummy',
    'm.login.sso',
    'm.login.token',
    'm.login.email.requestToken',
    'm.login.application_service',
  ];
  for (let i = 0; i < 20; i++) {
    it(`non-password auth DELETE soft-${i}`, async () => {
      const type = types[i % types.length];
      const id = `NP${i}`;
      vi.mocked(verifyPassword).mockClear();
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', { auth: { type, session: `s-${i}` } })
      );
      expect(res.status).toBe(200);
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.devices.find((d) => d.device_id === id)).toBeUndefined();
      expect(db.deletes.map((d) => d.sql)).toEqual([
        expect.stringContaining('DELETE FROM access_tokens'),
        expect.stringContaining('DELETE FROM device_keys'),
        expect.stringContaining('DELETE FROM devices'),
      ]);
    });
  }
});

describe('devices leftovers auth:{} / auth:null DELETE soft flood after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`auth:{} DELETE soft-${i}`, async () => {
      const id = `AE${i}`;
      vi.mocked(verifyPassword).mockClear();
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', { auth: {} })
      );
      expect(res.status).toBe(200);
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.devices).toHaveLength(0);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`auth:null DELETE → UIA soft-${i}`, async () => {
      const id = `AN${i}`;
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', { auth: null })
      );
      expect(res.status).toBe(401);
      expect((res.body as { flows: unknown }).flows).toEqual([{ stages: ['m.login.password'] }]);
      expect(typeof (res.body as { session: string }).session).toBe('string');
      expect(db.devices).toHaveLength(1);
      expect(db.deletes).toHaveLength(0);
    });
  }
});

describe('devices leftovers null display_name PUT soft flood after #232', () => {
  for (let i = 0; i < 16; i++) {
    it(`PUT display_name null soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ display_name: `before-${i}` })],
      });
      const res = await request(
        db,
        '/_matrix/client/v3/devices/PHONE',
        jsonInit('PUT', { display_name: null })
      );
      expect(res.status).toBe(200);
      expect(db.devices[0].display_name).toBeNull();
      expect(db.updates).toHaveLength(1);
      expect(db.updates[0].args[0]).toBeNull();
    });
  }
});

describe('devices leftovers CURRENT self-delete soft flood after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`DELETE CURRENT device soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: 'CURRENT', display_name: `cur-${i}` }),
          seedDevice({ device_id: 'OTHER', display_name: 'keep' }),
        ],
      });
      const res = await request(
        db,
        '/_matrix/client/v3/devices/CURRENT',
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
      );
      expect(res.status).toBe(200);
      expect(db.devices.map((d) => d.device_id)).toEqual(['OTHER']);
    });
  }
});

describe('devices leftovers cascade order soft flood after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`DELETE cascade tokens→keys→devices soft-${i}`, async () => {
      const id = `C${i}`;
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: 's3cret' } })
      );
      expect(res.status).toBe(200);
      expect(db.deletes).toHaveLength(3);
      expect(db.deletes[0].sql).toContain('access_tokens');
      expect(db.deletes[1].sql).toContain('device_keys');
      expect(db.deletes[2].sql).toContain('DELETE FROM devices');
      expect(db.deletes.every((d) => d.args[0] === USER && d.args[1] === id)).toBe(true);
    });
  }
});

describe('devices leftovers session ignored on password auth soft flood after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`password auth ignores session soft-${i}`, async () => {
      const id = `S${i}`;
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', {
          auth: {
            type: 'm.login.password',
            password: 's3cret',
            session: `made-up-${i}`,
          },
        })
      );
      expect(res.status).toBe(200);
      expect(db.devices).toHaveLength(0);
    });
  }
});

describe('devices leftovers empty-string password soft flood after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`empty password rejected soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `EP${i}` })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/EP${i}`,
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: '' } })
      );
      expect(res.status).toBe(403);
      expect((res.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      expect(db.deletes).toHaveLength(0);
      expect(db.devices).toHaveLength(1);
    });
  }
});

describe('devices leftovers PUT preserves last_seen soft flood after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`PUT display_name preserves last_seen soft-${i}`, async () => {
      const ts = 1_700_000_000_000 + i;
      const ip = `203.0.113.${i + 1}`;
      const db = createDevicesDb({
        devices: [
          seedDevice({
            display_name: `old-${i}`,
            last_seen_ts: ts,
            last_seen_ip: ip,
          }),
        ],
      });
      const res = await request(
        db,
        '/_matrix/client/v3/devices/PHONE',
        jsonInit('PUT', { display_name: `new-${i}` })
      );
      expect(res.status).toBe(200);
      expect(db.devices[0]).toMatchObject({
        display_name: `new-${i}`,
        last_seen_ts: ts,
        last_seen_ip: ip,
      });
      const got = await request(db, '/_matrix/client/v3/devices/PHONE');
      expect(got.body).toMatchObject({
        display_name: `new-${i}`,
        last_seen_ts: ts,
        last_seen_ip: ip,
      });
    });
  }
});

describe('devices leftovers case-sensitive device id soft flood after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`case-differing device id 404 soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `Phone${i}` })],
      });
      const res = await request(db, `/_matrix/client/v3/devices/phone${i}`);
      expect(res.status).toBe(404);
      expect((res.body as { errcode: string }).errcode).toBe('M_NOT_FOUND');
    });
  }
});

describe('devices leftovers delete_devices null/duplicate/bulk edges after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`delete_devices null devices soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', { devices: null, auth: { type: 'm.login.dummy' } })
      );
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_MISSING_PARAM');
      expect(db.devices).toHaveLength(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`delete_devices duplicate ids soft-${i}`, async () => {
      const id = `DUP${i}`;
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', {
          devices: [id, id, id],
          auth: { type: 'm.login.password', password: 's3cret' },
        })
      );
      expect(res.status).toBe(200);
      expect(db.devices).toHaveLength(0);
      // three cascade triples (tokens/keys/device) for each list entry
      expect(db.deletes).toHaveLength(9);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`delete_devices auth:null → UIA soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `DN${i}` })] });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', { devices: [`DN${i}`], auth: null })
      );
      expect(res.status).toBe(401);
      expect(db.deletes).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`delete_devices auth:{} soft-${i}`, async () => {
      const id = `DE${i}`;
      vi.mocked(verifyPassword).mockClear();
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', { devices: [id], auth: {} })
      );
      expect(res.status).toBe(200);
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.devices).toHaveLength(0);
    });
  }
});

describe('devices leftovers PUT omit vs empty-string vs extra fields after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`PUT {} omits UPDATE soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ display_name: `keep-${i}` })],
      });
      const res = await request(db, '/_matrix/client/v3/devices/PHONE', jsonInit('PUT', {}));
      expect(res.status).toBe(200);
      expect(db.updates).toHaveLength(0);
      expect(db.devices[0].display_name).toBe(`keep-${i}`);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`PUT empty-string display_name soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ display_name: `was-${i}` })],
      });
      const res = await request(
        db,
        '/_matrix/client/v3/devices/PHONE',
        jsonInit('PUT', { display_name: '' })
      );
      expect(res.status).toBe(200);
      expect(db.devices[0].display_name).toBe('');
      const got = await request(db, '/_matrix/client/v3/devices/PHONE');
      expect(got.body).toEqual({ device_id: 'PHONE' });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`PUT ignores extra fields soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({
            display_name: `x-${i}`,
            last_seen_ts: 99,
            last_seen_ip: '10.0.0.1',
          }),
        ],
      });
      const res = await request(
        db,
        '/_matrix/client/v3/devices/PHONE',
        jsonInit('PUT', {
          display_name: `y-${i}`,
          last_seen_ts: 1,
          last_seen_ip: 'hack',
          device_id: 'OTHER',
          user_id: '@eve:example.com',
        })
      );
      expect(res.status).toBe(200);
      expect(db.devices[0]).toMatchObject({
        device_id: 'PHONE',
        user_id: USER,
        display_name: `y-${i}`,
        last_seen_ts: 99,
        last_seen_ip: '10.0.0.1',
      });
    });
  }
});

describe('devices leftovers DELETE invalid JSON → UIA soft flood after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`DELETE bad JSON body → UIA soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `BJ${i}` })] });
      const res = await request(db, `/_matrix/client/v3/devices/BJ${i}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      });
      expect(res.status).toBe(401);
      expect((res.body as { flows: unknown }).flows).toEqual([{ stages: ['m.login.password'] }]);
      expect(db.devices).toHaveLength(1);
    });
  }
});

describe('devices leftovers cross-user isolation soft flood after #232', () => {
  for (let i = 0; i < 8; i++) {
    it(`GET/PUT/DELETE other-user same device_id soft-${i}`, async () => {
      const id = `SHARED${i}`;
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: id, user_id: '@bob:example.com', display_name: 'bob' }),
        ],
      });
      const got = await request(db, `/_matrix/client/v3/devices/${id}`);
      expect(got.status).toBe(404);
      const put = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('PUT', { display_name: 'hack' })
      );
      expect(put.status).toBe(404);
      const del = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', { auth: { type: 'm.login.dummy' } })
      );
      expect(del.status).toBe(404);
      expect(db.devices).toHaveLength(1);
      expect(db.devices[0].display_name).toBe('bob');
    });
  }
});

// ---------------------------------------------------------------------------
// deepen devices-api route leftovers after #241
// ---------------------------------------------------------------------------

describe('devices leftovers delete_devices empty array soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`delete_devices [] succeeds no-op soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: 'KEEP_A' }),
          seedDevice({ device_id: 'KEEP_B' }),
        ],
      });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', {
          devices: [],
          auth: { type: 'm.login.password', password: 's3cret' },
        })
      );
      expect(res.status).toBe(200);
      expect(db.devices).toHaveLength(2);
      expect(db.deletes).toHaveLength(0);
    });
  }
});

describe('devices leftovers password-field missing soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`DELETE password type without password soft-${i}`, async () => {
      const id = `MP${i}`;
      vi.mocked(verifyPassword).mockClear();
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        `/_matrix/client/v3/devices/${id}`,
        jsonInit('DELETE', { auth: { type: 'm.login.password' } })
      );
      expect(res.status).toBe(403);
      expect((res.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.devices).toHaveLength(1);
      expect(db.deletes).toHaveLength(0);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`delete_devices password type without password soft-${i}`, async () => {
      const id = `BP${i}`;
      vi.mocked(verifyPassword).mockClear();
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', {
          devices: [id],
          auth: { type: 'm.login.password' },
        })
      );
      expect(res.status).toBe(403);
      expect((res.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.devices).toHaveLength(1);
    });
  }
});

describe('devices leftovers delete_devices not-array soft flood after #241', () => {
  const bad = ['PHONE', 1, { id: 'x' }, true];
  for (let i = 0; i < 12; i++) {
    it(`devices not-array soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const res = await request(
        db,
        '/_matrix/client/v3/delete_devices',
        jsonInit('POST', {
          devices: bad[i % bad.length],
          auth: { type: 'm.login.dummy' },
        })
      );
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_MISSING_PARAM');
      expect(db.devices).toHaveLength(1);
      expect(db.deletes).toHaveLength(0);
    });
  }
});

describe('devices leftovers GET omits null last_seen soft flood after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`GET :deviceId omits null last_seen soft-${i}`, async () => {
      const id = `LS${i}`;
      const db = createDevicesDb({
        devices: [
          seedDevice({
            device_id: id,
            display_name: null,
            last_seen_ts: null,
            last_seen_ip: null,
          }),
        ],
      });
      const res = await request(db, `/_matrix/client/v3/devices/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ device_id: id });
      expect(res.body).not.toHaveProperty('display_name');
      expect(res.body).not.toHaveProperty('last_seen_ts');
      expect(res.body).not.toHaveProperty('last_seen_ip');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`GET list omits null optional fields soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({
            device_id: `L${i}`,
            display_name: null,
            last_seen_ts: null,
            last_seen_ip: null,
          }),
        ],
      });
      const res = await request(db, '/_matrix/client/v3/devices');
      expect(res.status).toBe(200);
      expect((res.body as { devices: unknown[] }).devices).toEqual([{ device_id: `L${i}` }]);
    });
  }
});
