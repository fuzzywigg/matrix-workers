/**
 * TOKENMAXX HEAVY deepen — different slice: device management API routes.
 * Avoids search (#94), key-backups (#96/#93), oauth (#90), spaces (#89), VoIP/TURN.
 * Tests-only — no product inventing.
 * Exercises list/get/update/delete device + delete_devices UIA password flows.
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
const PINNED_UUID = '11111111-2222-3333-4444-555555555555';

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
  /** Force password_hash SELECT to return null user row. */
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
                const [displayName, userId, deviceId] = args as [
                  string,
                  string,
                  string,
                ];
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

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
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

describe('devices GET /_matrix/client/v3/devices', () => {
  it('returns empty list when user has no devices', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [] });
  });

  it('maps null display_name / last_seen_* to undefined (omitted)', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'A',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
        }),
        seedDevice({
          device_id: 'B',
          display_name: 'Laptop',
          last_seen_ts: 1_700_000_000_000,
          last_seen_ip: '203.0.113.9',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [
        { device_id: 'A' },
        {
          device_id: 'B',
          display_name: 'Laptop',
          last_seen_ts: 1_700_000_000_000,
          last_seen_ip: '203.0.113.9',
        },
      ],
    });
  });

  it('does not leak another user devices (WHERE user_id scoped)', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'MINE', user_id: USER }),
        seedDevice({ device_id: 'THEIRS', user_id: '@bob:example.com' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices');
    expect(res.status).toBe(200);
    expect((res.body as { devices: Array<{ device_id: string }> }).devices).toEqual([
      { device_id: 'MINE' },
    ]);
  });
});

describe('devices GET /_matrix/client/v3/devices/:deviceId', () => {
  it('returns 404 when device missing', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(db, '/_matrix/client/v3/devices/MISSING');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns device with optional fields when present', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'PHONE',
          display_name: 'Pixel',
          last_seen_ts: 99,
          last_seen_ip: '10.0.0.1',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      device_id: 'PHONE',
      display_name: 'Pixel',
      last_seen_ts: 99,
      last_seen_ip: '10.0.0.1',
    });
  });

  it('omits null optional fields on single-device get', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'BARE' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/BARE');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: 'BARE' });
  });
});

describe('devices PUT /_matrix/client/v3/devices/:deviceId', () => {
  it('rejects non-JSON with M_BAD_JSON', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(db.updates).toEqual([]);
  });

  it('returns 404 when updating unknown device', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/NOPE',
      jsonInit('PUT', { display_name: 'x' })
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('no-ops update when display_name omitted (still 200)', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'Keep' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.updates).toEqual([]);
    expect(db.devices[0].display_name).toBe('Keep');
  });

  it('updates display_name including empty string', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'Old' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: '' })
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('');
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].args).toEqual(['', USER, 'PHONE']);
  });

  it('updates display_name to a new label', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'Old' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'New Phone' })
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe('New Phone');
  });
});

describe('devices DELETE /_matrix/client/v3/devices/:deviceId', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    vi.mocked(verifyPassword).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 before UIA when device missing', async () => {
    const db = createDevicesDb({ devices: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/GONE',
      jsonInit('DELETE', {})
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns UIA challenge when body has no auth (including empty body)', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      flows: [{ stages: ['m.login.password'] }],
      params: {},
      session: PINNED_UUID,
    });
    expect(db.deletes).toEqual([]);
  });

  it('returns UIA when JSON body lacks auth field', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { note: 'no auth' })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
      session: PINNED_UUID,
    });
  });

  it('rejects password auth when user row missing', async () => {
    const db = createDevicesDb({
      devices: [seedDevice()],
      missingUser: true,
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN', error: 'Invalid password' });
    expect(db.deletes).toEqual([]);
  });

  it('rejects password auth when password field missing', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: { type: 'm.login.password' } })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('rejects wrong password via verifyPassword', async () => {
    const db = createDevicesDb({
      devices: [seedDevice()],
      passwordHash: 'mockok:s3cret',
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 'wrong' },
      })
    );
    expect(res.status).toBe(403);
    expect(verifyPassword).toHaveBeenCalledWith('wrong', 'mockok:s3cret');
    expect(db.deletes).toEqual([]);
    expect(db.devices).toHaveLength(1);
  });

  it('deletes tokens, keys, and device after valid password', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' }), seedDevice({ device_id: 'KEEP' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(verifyPassword).toHaveBeenCalledWith('s3cret', 'mockok:s3cret');
    expect(db.deletes.map((d) => d.sql.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('DELETE FROM access_tokens'),
      expect.stringContaining('DELETE FROM device_keys'),
      expect.stringContaining('DELETE FROM devices'),
    ]);
    expect(db.devices.map((d) => d.device_id)).toEqual(['KEEP']);
  });

  it('skips password verify when auth type is not m.login.password (still deletes)', async () => {
    // Current implementation only verifies when type === m.login.password;
    // other auth types fall through to delete. Lock that behavior.
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.dummy', session: 'x' },
      })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.devices).toHaveLength(0);
  });
});

describe('devices POST /_matrix/client/v3/delete_devices', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    vi.mocked(verifyPassword).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-JSON with M_BAD_JSON', async () => {
    const db = createDevicesDb();
    const res = await request(db, '/_matrix/client/v3/delete_devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects missing devices array with M_MISSING_PARAM', async () => {
    const db = createDevicesDb();
    const a = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {})
    );
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const b = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: 'PHONE' })
    );
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('returns UIA when auth omitted even with devices list', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: ['A'] })
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      flows: [{ stages: ['m.login.password'] }],
      params: {},
      session: PINNED_UUID,
    });
    expect(db.deletes).toEqual([]);
  });

  it('rejects invalid password for bulk delete', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' })],
      passwordHash: 'mockok:s3cret',
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A'],
        auth: { type: 'm.login.password', password: 'nope' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.devices).toHaveLength(1);
  });

  it('rejects when password missing on m.login.password bulk auth', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'A' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A'],
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(403);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('rejects when user missing on bulk password auth', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' })],
      missingUser: true,
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(403);
  });

  it('deletes multiple devices after valid password', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A' }),
        seedDevice({ device_id: 'B' }),
        seedDevice({ device_id: 'C' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A', 'C'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.devices.map((d) => d.device_id)).toEqual(['B']);
    // 3 deletes per device × 2 devices
    expect(db.deletes).toHaveLength(6);
  });

  it('accepts empty devices array with auth (no deletes)', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' })],
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
    expect(db.deletes).toEqual([]);
    expect(db.devices).toHaveLength(1);
  });

  it('bulk-deletes without password verify for non-password auth type', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A'],
        auth: { type: 'm.login.token', session: 's' },
      })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.devices.map((d) => d.device_id)).toEqual(['B']);
  });

  it('still runs DELETE for unknown device ids (idempotent cleanup)', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'KEEP' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['GHOST'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.deletes).toHaveLength(3);
    expect(db.devices.map((d) => d.device_id)).toEqual(['KEEP']);
  });
});
