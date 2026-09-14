/**
 * TOKENMAXX HEAVY deepen — different slice: device management API routes.
 * After #123 (relations/threads). Avoids federation keys/events/S2S, sliding-sync/sync,
 * voip/rooms/oidc/media/relations/threads leftovers.
 * Tests-only — no product inventing.
 * Exercises list/get/update/delete device + delete_devices UIA password flows,
 * falsy optional-field omission (`|| undefined`), SQL bind contracts, auth-type
 * fallthrough, bulk delete ordering/idempotency, and URL device-id decode.
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

// =============================================================================
// TOKENMAXX HEAVY leftovers after #123 — response shape / falsy / UIA / binds
// =============================================================================

const OTHER = '@bob:example.com';
const AUTH = { Authorization: 'Bearer test-token' };

function authOnlyGet(): RequestInit {
  return { method: 'GET', headers: AUTH };
}

describe('devices GET list — falsy optional fields via || undefined', () => {
  it('omits empty-string display_name and last_seen_ip (falsy → undefined)', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'EMPTY',
          display_name: '',
          last_seen_ts: 1,
          last_seen_ip: '',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      devices: [{ device_id: 'EMPTY', last_seen_ts: 1 }],
    });
  });

  it('omits last_seen_ts=0 because 0 is falsy under || undefined', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'ZERO',
          display_name: 'Z',
          last_seen_ts: 0,
          last_seen_ip: '127.0.0.1',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'ZERO',
          display_name: 'Z',
          last_seen_ip: '127.0.0.1',
        },
      ],
    });
  });

  it('preserves positive last_seen_ts including small integers', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'T1', last_seen_ts: 1, display_name: 'a' }),
        seedDevice({ device_id: 'T2', last_seen_ts: 42, display_name: 'b' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    const devices = (res.body as { devices: Array<{ device_id: string; last_seen_ts?: number }> })
      .devices;
    expect(devices.find((d) => d.device_id === 'T1')?.last_seen_ts).toBe(1);
    expect(devices.find((d) => d.device_id === 'T2')?.last_seen_ts).toBe(42);
  });

  it('binds authenticated userId into list SELECT (SQL contract)', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    const sel = db.selects.find(
      (s) => s.sql.includes('FROM devices') && !s.sql.includes('device_id = ?')
    );
    expect(sel?.args).toEqual([USER]);
  });

  it('returns many devices without collapsing duplicates by display_name', async () => {
    const db = createDevicesDb({
      devices: Array.from({ length: 12 }, (_, i) =>
        seedDevice({
          device_id: `D${i}`,
          display_name: i % 2 === 0 ? 'Same' : `N${i}`,
          last_seen_ts: 1000 + i,
        })
      ),
    });
    const res = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect((res.body as { devices: unknown[] }).devices).toHaveLength(12);
  });

  it('unicode / emoji display names round-trip on list', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'JP',
          display_name: '東京タブレット📱',
          last_seen_ts: 9,
          last_seen_ip: '2001:db8::1',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect(res.body).toEqual({
      devices: [
        {
          device_id: 'JP',
          display_name: '東京タブレット📱',
          last_seen_ts: 9,
          last_seen_ip: '2001:db8::1',
        },
      ],
    });
  });
});

describe('devices GET :deviceId — decode, isolation, falsy map', () => {
  it('returns 404 when device exists only for another user', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE', user_id: OTHER })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', authOnlyGet());
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('binds [userId, deviceId] on single-device SELECT', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'X1' })] });
    await request(db, '/_matrix/client/v3/devices/X1', authOnlyGet());
    const sel = db.selects.find(
      (s) =>
        s.sql.includes('FROM devices') &&
        s.sql.includes('device_id = ?') &&
        s.sql.includes('display_name')
    );
    expect(sel?.args).toEqual([USER, 'X1']);
  });

  it('omits empty-string display_name on single get', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'BLANK',
          display_name: '',
          last_seen_ts: 5,
          last_seen_ip: '1.2.3.4',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices/BLANK', authOnlyGet());
    expect(res.body).toEqual({
      device_id: 'BLANK',
      last_seen_ts: 5,
      last_seen_ip: '1.2.3.4',
    });
  });

  it('omits last_seen_ts=0 on single get', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'Z',
          display_name: 'z',
          last_seen_ts: 0,
          last_seen_ip: '::1',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/devices/Z', authOnlyGet());
    expect(res.body).toEqual({
      device_id: 'Z',
      display_name: 'z',
      last_seen_ip: '::1',
    });
  });

  it('accepts device ids with dots, dashes, and underscores', async () => {
    const id = 'Element-Web.ABCDEF_01';
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: id, display_name: 'Web' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/devices/${encodeURIComponent(id)}`,
      authOnlyGet()
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device_id: id, display_name: 'Web' });
  });

  it('does not match case-differing device ids (exact bind)', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'Phone' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', authOnlyGet());
    expect(res.status).toBe(404);
  });
});

describe('devices PUT — body edges and SQL binds', () => {
  it('writes null display_name when body.display_name is null (!== undefined)', async () => {
    // Handler checks `!== undefined`, so null is written through to UPDATE.
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE', display_name: 'Old' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: null })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].args).toEqual([null, USER, 'PHONE']);
    expect(db.devices[0].display_name).toBeNull();
  });

  it('updates with unicode / long display_name', async () => {
    const long = `名前-${'x'.repeat(200)}`;
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'PHONE' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: long })
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe(long);
  });

  it('ignores extra body fields besides display_name', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'PHONE',
          display_name: 'Keep',
          last_seen_ts: 50,
          last_seen_ip: '9.9.9.9',
        }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', {
        display_name: 'New',
        last_seen_ts: 999,
        last_seen_ip: '1.1.1.1',
        device_id: 'HIJACK',
      })
    );
    expect(res.status).toBe(200);
    expect(db.devices[0]).toMatchObject({
      device_id: 'PHONE',
      display_name: 'New',
      last_seen_ts: 50,
      last_seen_ip: '9.9.9.9',
    });
  });

  it('404 when device belongs to another user (existence check scoped)', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE', user_id: OTHER, display_name: 'Bob' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 'Hack' })
    );
    expect(res.status).toBe(404);
    expect(db.updates).toEqual([]);
    expect(db.devices[0].display_name).toBe('Bob');
  });

  it('existence SELECT runs before UPDATE; binds userId+deviceId', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'D9' })] });
    await request(db, '/_matrix/client/v3/devices/D9', jsonInit('PUT', { display_name: 'n' }));
    const existence = db.selects.find(
      (s) =>
        s.sql.includes('SELECT device_id FROM devices') && s.sql.includes('device_id = ?')
    );
    expect(existence?.args).toEqual([USER, 'D9']);
    expect(db.updates[0].args).toEqual(['n', USER, 'D9']);
  });

  it('empty object body skips UPDATE entirely', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE', display_name: 'Stay' })],
    });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', jsonInit('PUT', {}));
    expect(res.status).toBe(200);
    expect(db.updates).toEqual([]);
    expect(db.devices[0].display_name).toBe('Stay');
  });

  it('rejects array JSON body as bad JSON path still parses — treated as object without display_name', async () => {
    // JSON.parse('[]') succeeds; body.display_name is undefined → no-op 200.
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '[]',
    });
    expect(res.status).toBe(200);
    expect(db.updates).toEqual([]);
  });

  it('rejects truly invalid JSON', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
});

describe('devices DELETE — UIA session / auth matrix', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    vi.mocked(verifyPassword).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UIA challenge shape is stable (flows/params/session)', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      flows: [{ stages: ['m.login.password'] }],
      params: {},
      session: PINNED_UUID,
    });
  });

  it('auth:null is truthy-check failure → UIA (null auth treated as missing)', async () => {
    // `if (!auth)` — null is falsy, so UIA fires.
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: null })
    );
    expect(res.status).toBe(401);
    expect(db.deletes).toEqual([]);
  });

  it('auth:{} is truthy with no type → skips password verify and deletes', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: {} })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.devices).toHaveLength(0);
  });

  it('auth.type undefined with password present still skips verifyPassword', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', { auth: { password: 's3cret' } })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('m.login.password with empty-string password is rejected before verify', async () => {
    // `!auth.password` — empty string is falsy.
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: '' },
      })
    );
    expect(res.status).toBe(403);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.devices).toHaveLength(1);
  });

  it('allows deleting the currently authenticated device id (CURRENT)', async () => {
    // Handler voids c.get('deviceId') — no self-delete guard today.
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'CURRENT' }),
        seedDevice({ device_id: 'OTHER' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/CURRENT',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.devices.map((d) => d.device_id)).toEqual(['OTHER']);
  });

  it('DELETE cascade order is access_tokens → device_keys → devices', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'ORD' })] });
    await request(
      db,
      '/_matrix/client/v3/devices/ORD',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(db.deletes.map((d) => d.sql.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('DELETE FROM access_tokens'),
      expect.stringContaining('DELETE FROM device_keys'),
      expect.stringContaining('DELETE FROM devices'),
    ]);
    expect(db.deletes.every((d) => d.args[0] === USER && d.args[1] === 'ORD')).toBe(true);
  });

  it('does not delete another users device with same device_id', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'PHONE', user_id: USER }),
        seedDevice({ device_id: 'PHONE', user_id: OTHER }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.devices).toEqual([
      expect.objectContaining({ device_id: 'PHONE', user_id: OTHER }),
    ]);
  });

  it('password_hash SELECT binds only userId', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    const pw = db.selects.find((s) => s.sql.includes('SELECT password_hash FROM users'));
    expect(pw?.args).toEqual([USER]);
  });

  it('session field on password auth is ignored (not validated)', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: {
          type: 'm.login.password',
          password: 's3cret',
          session: 'totally-made-up',
        },
      })
    );
    expect(res.status).toBe(200);
    expect(db.devices).toHaveLength(0);
  });

  it('m.login.password wrong password leaves device and issues no DELETEs', async () => {
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
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.deletes).toEqual([]);
    expect(db.devices).toHaveLength(1);
  });

  it('non-password auth types: m.login.sso / token / email / dummy all delete', async () => {
    for (const type of ['m.login.sso', 'm.login.token', 'm.login.email.requestToken', 'm.login.dummy']) {
      vi.mocked(verifyPassword).mockClear();
      const db = createDevicesDb({ devices: [seedDevice({ device_id: 'T' })] });
      const res = await request(
        db,
        '/_matrix/client/v3/devices/T',
        jsonInit('DELETE', { auth: { type, session: 's' } })
      );
      expect(res.status).toBe(200);
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.devices).toHaveLength(0);
    }
  });
});

describe('devices POST delete_devices — bulk edges', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    vi.mocked(verifyPassword).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects null devices with M_MISSING_PARAM', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: null, auth: { type: 'm.login.dummy' } })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('UIA when auth is null even with devices list', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'A' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: ['A'], auth: null })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ session: PINNED_UUID });
    expect(db.deletes).toEqual([]);
  });

  it('auth:{} bulk-deletes without password verify', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: ['A', 'B'], auth: {} })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.devices).toHaveLength(0);
  });

  it('dedupes nothing — duplicate device ids run DELETE cascade twice', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'A' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A', 'A'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    // 3 deletes × 2 iterations
    expect(db.deletes).toHaveLength(6);
    expect(db.devices).toHaveLength(0);
  });

  it('preserves devices not listed in the bulk request', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'KEEP1' }),
        seedDevice({ device_id: 'DEL' }),
        seedDevice({ device_id: 'KEEP2' }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['DEL'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(db.devices.map((d) => d.device_id).sort()).toEqual(['KEEP1', 'KEEP2']);
  });

  it('bulk delete does not touch other users devices with same ids', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'SHARED', user_id: USER }),
        seedDevice({ device_id: 'SHARED', user_id: OTHER }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['SHARED'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(db.devices).toEqual([
      expect.objectContaining({ device_id: 'SHARED', user_id: OTHER }),
    ]);
  });

  it('empty-string password on bulk m.login.password → forbidden, no deletes', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'A' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A'],
        auth: { type: 'm.login.password', password: '' },
      })
    );
    expect(res.status).toBe(403);
    expect(db.deletes).toEqual([]);
  });

  it('processes devices in request order for DELETE cascades', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A' }),
        seedDevice({ device_id: 'B' }),
        seedDevice({ device_id: 'C' }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['C', 'A'],
        auth: { type: 'm.login.dummy' },
      })
    );
    const deviceDeletes = db.deletes.filter((d) => d.sql.includes('DELETE FROM devices'));
    expect(deviceDeletes.map((d) => d.args[1])).toEqual(['C', 'A']);
    expect(db.devices.map((d) => d.device_id)).toEqual(['B']);
  });

  it('large bulk list deletes all requested devices', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `DEV${i}`);
    const db = createDevicesDb({
      devices: ids.map((device_id) => seedDevice({ device_id })),
    });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ids,
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.devices).toHaveLength(0);
    expect(db.deletes).toHaveLength(25 * 3);
  });

  it('verifyPassword receives stored hash and submitted password on bulk', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' })],
      passwordHash: 'mockok:bulk-pass',
    });
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A'],
        auth: { type: 'm.login.password', password: 'bulk-pass' },
      })
    );
    expect(verifyPassword).toHaveBeenCalledWith('bulk-pass', 'mockok:bulk-pass');
  });
});

describe('devices TOKENMAXX integration lifecycles after #123', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    vi.mocked(verifyPassword).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('list → get → rename → get → delete → list', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'FLOW',
          display_name: 'Old',
          last_seen_ts: 10,
          last_seen_ip: '10.0.0.2',
        }),
      ],
    });

    const list1 = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect((list1.body as { devices: unknown[] }).devices).toHaveLength(1);

    const get1 = await request(db, '/_matrix/client/v3/devices/FLOW', authOnlyGet());
    expect(get1.body).toMatchObject({ display_name: 'Old' });

    const put = await request(
      db,
      '/_matrix/client/v3/devices/FLOW',
      jsonInit('PUT', { display_name: 'Renamed' })
    );
    expect(put.status).toBe(200);

    const get2 = await request(db, '/_matrix/client/v3/devices/FLOW', authOnlyGet());
    expect(get2.body).toMatchObject({ display_name: 'Renamed', last_seen_ts: 10 });

    const del = await request(
      db,
      '/_matrix/client/v3/devices/FLOW',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(del.status).toBe(200);

    const list2 = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect(list2.body).toEqual({ devices: [] });
    const get3 = await request(db, '/_matrix/client/v3/devices/FLOW', authOnlyGet());
    expect(get3.status).toBe(404);
  });

  it('UIA then password retry succeeds on single delete', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'RETRY' })] });

    const challenge = await request(db, '/_matrix/client/v3/devices/RETRY', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(challenge.status).toBe(401);
    expect((challenge.body as { session: string }).session).toBe(PINNED_UUID);
    expect(db.devices).toHaveLength(1);

    const ok = await request(
      db,
      '/_matrix/client/v3/devices/RETRY',
      jsonInit('DELETE', {
        auth: {
          type: 'm.login.password',
          password: 's3cret',
          session: (challenge.body as { session: string }).session,
        },
      })
    );
    expect(ok.status).toBe(200);
    expect(db.devices).toHaveLength(0);
  });

  it('bulk UIA then password deletes subset', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A' }),
        seedDevice({ device_id: 'B' }),
        seedDevice({ device_id: 'C' }),
      ],
    });

    const challenge = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: ['A', 'C'] })
    );
    expect(challenge.status).toBe(401);

    const ok = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A', 'C'],
        auth: { type: 'm.login.password', password: 's3cret', session: PINNED_UUID },
      })
    );
    expect(ok.status).toBe(200);
    expect(db.devices.map((d) => d.device_id)).toEqual(['B']);
  });

  it('rename then bulk-delete the renamed device', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'X', display_name: 'one' }),
        seedDevice({ device_id: 'Y', display_name: 'two' }),
      ],
    });
    await request(db, '/_matrix/client/v3/devices/X', jsonInit('PUT', { display_name: 'neo' }));
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['X'],
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    const list = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect(list.body).toEqual({
      devices: [{ device_id: 'Y', display_name: 'two' }],
    });
  });

  it('GET list SQL never includes device_id filter; GET one always does', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    await request(db, '/_matrix/client/v3/devices/A', authOnlyGet());

    const listSel = db.selects.filter(
      (s) => s.sql.includes('FROM devices') && s.sql.includes('WHERE user_id = ?')
    );
    expect(listSel.some((s) => !s.sql.includes('device_id = ?'))).toBe(true);
    expect(listSel.some((s) => s.sql.includes('device_id = ?'))).toBe(true);
  });
});

describe('devices response errcode vocabulary', () => {
  it('single GET miss uses M_NOT_FOUND', async () => {
    const db = createDevicesDb();
    const res = await request(db, '/_matrix/client/v3/devices/NOPE', authOnlyGet());
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('PUT miss uses M_NOT_FOUND', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/devices/NOPE',
      jsonInit('PUT', { display_name: 'x' })
    );
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('DELETE miss uses M_NOT_FOUND before UIA', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/devices/NOPE',
      jsonInit('DELETE', {})
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('bad password uses M_FORBIDDEN', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 'nope' },
      })
    );
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('bulk missing devices uses M_MISSING_PARAM', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { auth: { type: 'm.login.dummy' } })
    );
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('PUT bad JSON uses M_BAD_JSON', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: 'nope',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('bulk bad JSON uses M_BAD_JSON', async () => {
    const db = createDevicesDb();
    const res = await request(db, '/_matrix/client/v3/delete_devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: 'nope',
    });
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
});

describe('devices SQL bind contracts — every mutating path', () => {
  beforeEach(() => {
    vi.mocked(verifyPassword).mockClear();
  });

  it('PUT UPDATE binds display_name, user_id, device_id in that order', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'P1' })] });
    await request(
      db,
      '/_matrix/client/v3/devices/P1',
      jsonInit('PUT', { display_name: 'Label' })
    );
    expect(db.updates[0].args).toEqual(['Label', USER, 'P1']);
  });

  it('single DELETE binds userId+deviceId on each of three DELETE statements', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'P2' })] });
    await request(
      db,
      '/_matrix/client/v3/devices/P2',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(db.deletes).toHaveLength(3);
    for (const d of db.deletes) {
      expect(d.args).toEqual([USER, 'P2']);
    }
  });

  it('bulk DELETE binds each device id separately across cascades', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: ['A', 'B'],
        auth: { type: 'm.login.dummy' },
      })
    );
    const deviceIdArgs = db.deletes.map((d) => d.args[1]);
    expect(deviceIdArgs).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
  });
});

describe('devices dense stress — many devices + mixed fields', () => {
  it('lists 40 devices with mixed null/defined optional fields', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      seedDevice({
        device_id: `D${i}`,
        display_name: i % 3 === 0 ? null : `Name ${i}`,
        last_seen_ts: i % 4 === 0 ? null : i % 5 === 0 ? 0 : 1000 + i,
        last_seen_ip: i % 2 === 0 ? null : i % 7 === 0 ? '' : `10.0.0.${i}`,
      })
    );
    const db = createDevicesDb({ devices: rows });
    const res = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    expect(res.status).toBe(200);
    const devices = (res.body as { devices: Array<Record<string, unknown>> }).devices;
    expect(devices).toHaveLength(40);

    for (let i = 0; i < 40; i++) {
      const d = devices.find((x) => x.device_id === `D${i}`)!;
      expect(d.device_id).toBe(`D${i}`);
      if (i % 3 === 0) expect('display_name' in d).toBe(false);
      else expect(d.display_name).toBe(`Name ${i}`);
      // null or 0 → omitted
      if (i % 4 === 0 || i % 5 === 0) expect('last_seen_ts' in d).toBe(false);
      else expect(d.last_seen_ts).toBe(1000 + i);
      // null or '' → omitted
      if (i % 2 === 0 || i % 7 === 0) expect('last_seen_ip' in d).toBe(false);
      else expect(d.last_seen_ip).toBe(`10.0.0.${i}`);
    }
  });

  it('bulk-deletes every other device from a dense set', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const db = createDevicesDb({
      devices: ids.map((device_id) => seedDevice({ device_id })),
    });
    const toDelete = ids.filter((_, i) => i % 2 === 0);
    await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: toDelete,
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(db.devices.map((d) => d.device_id).sort()).toEqual(
      ids.filter((_, i) => i % 2 === 1).sort()
    );
  });
});

describe('devices password_hash / missingUser matrix', () => {
  beforeEach(() => {
    vi.mocked(verifyPassword).mockClear();
  });

  it('passwordHash null with m.login.password → forbidden (user row present, hash null)', async () => {
    const db = createDevicesDb({
      devices: [seedDevice()],
      passwordHash: null,
    });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    // user row exists so !user is false; verifyPassword(password, null) depends on mock —
    // mock compares storedHash === `mockok:${password}` → null !== mockok:s3cret → invalid
    expect(res.status).toBe(403);
    expect(db.devices).toHaveLength(1);
  });

  it('missingUser short-circuits before verifyPassword on single delete', async () => {
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
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('missingUser short-circuits on bulk delete', async () => {
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
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.deletes).toEqual([]);
  });

  it('custom passwordHash requires matching password suffix after mockok:', async () => {
    const db = createDevicesDb({
      devices: [seedDevice()],
      passwordHash: 'mockok:correct-horse',
    });
    const bad = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(bad.status).toBe(403);

    const good = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        auth: { type: 'm.login.password', password: 'correct-horse' },
      })
    );
    expect(good.status).toBe(200);
    expect(db.devices).toHaveLength(0);
  });
});

describe('devices PUT display_name type coercion passthrough', () => {
  it('stores numeric display_name as-is (no String() coercion in handler)', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: 123 as unknown as string })
    );
    expect(res.status).toBe(200);
    expect(db.updates[0].args[0]).toBe(123);
  });

  it('stores boolean display_name as-is', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: false as unknown as string })
    );
    expect(db.updates[0].args[0]).toBe(false);
  });

  it('stores object display_name as-is', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const obj = { nested: true };
    await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: obj as unknown as string })
    );
    expect(db.updates[0].args[0]).toEqual(obj);
  });

  it('whitespace-only display_name is truthy and preserved on subsequent GET', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('PUT', { display_name: '   ' })
    );
    const get = await request(db, '/_matrix/client/v3/devices/PHONE', authOnlyGet());
    expect(get.body).toMatchObject({ display_name: '   ' });
  });
});

describe('devices DELETE body parse edges', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    vi.mocked(verifyPassword).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DELETE with empty string body → JSON parse fail → UIA', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '',
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ session: PINNED_UUID });
  });

  it('DELETE with invalid JSON body → UIA (auth catch path)', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{not-json',
    });
    expect(res.status).toBe(401);
  });

  it('DELETE with JSON array body → auth undefined → UIA', async () => {
    // body.auth on an array is undefined
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '[]',
    });
    expect(res.status).toBe(401);
  });

  it('DELETE with JSON string body → auth undefined → UIA', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '"hello"',
    });
    expect(res.status).toBe(401);
  });

  it('DELETE with auth nested under wrong key still UIA', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(
      db,
      '/_matrix/client/v3/devices/PHONE',
      jsonInit('DELETE', {
        authentication: { type: 'm.login.password', password: 's3cret' },
      })
    );
    expect(res.status).toBe(401);
    expect(db.devices).toHaveLength(1);
  });
});

describe('devices bulk request validation matrix', () => {
  it('rejects devices as number', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: 1, auth: { type: 'm.login.dummy' } })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects devices as object', async () => {
    const db = createDevicesDb();
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', { devices: { id: 'A' }, auth: { type: 'm.login.dummy' } })
    );
    expect(res.status).toBe(400);
  });

  it('accepts devices array containing non-strings (still runs DELETE binds)', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'A' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/delete_devices',
      jsonInit('POST', {
        devices: [123, null, 'A'] as unknown as string[],
        auth: { type: 'm.login.dummy' },
      })
    );
    expect(res.status).toBe(200);
    // three cascade groups
    expect(db.deletes).toHaveLength(9);
    expect(db.devices).toHaveLength(0);
  });

  it('does not require Content-Type for DELETE UIA with no body', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    vi.restoreAllMocks();
  });
});

describe('devices cross-endpoint isolation leftovers', () => {
  it('PUT on device A does not alter device B', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A', display_name: 'a' }),
        seedDevice({ device_id: 'B', display_name: 'b' }),
      ],
    });
    await request(db, '/_matrix/client/v3/devices/A', jsonInit('PUT', { display_name: 'aa' }));
    expect(db.devices.find((d) => d.device_id === 'B')?.display_name).toBe('b');
    expect(db.devices.find((d) => d.device_id === 'A')?.display_name).toBe('aa');
  });

  it('single DELETE of A leaves B tokens/keys path uncalled for B', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    await request(
      db,
      '/_matrix/client/v3/devices/A',
      jsonInit('DELETE', { auth: { type: 'm.login.dummy' } })
    );
    expect(db.deletes.every((d) => d.args[1] === 'A')).toBe(true);
    expect(db.devices.map((d) => d.device_id)).toEqual(['B']);
  });

  it('list after mixed null updates reflects || undefined omission', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A', display_name: 'x' })],
    });
    await request(
      db,
      '/_matrix/client/v3/devices/A',
      jsonInit('PUT', { display_name: null })
    );
    const list = await request(db, '/_matrix/client/v3/devices', authOnlyGet());
    // null display_name → omitted via || undefined
    expect(list.body).toEqual({ devices: [{ device_id: 'A' }] });
  });

  it('GET one after PUT empty string omits display_name in response', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A', display_name: 'x' })],
    });
    await request(db, '/_matrix/client/v3/devices/A', jsonInit('PUT', { display_name: '' }));
    const get = await request(db, '/_matrix/client/v3/devices/A', authOnlyGet());
    expect(get.body).toEqual({ device_id: 'A' });
  });
});

describe('devices UIA session uniqueness pinning', () => {
  it('each UIA challenge without mock still returns UUID-shaped session', async () => {
    // Do not mock randomUUID — assert shape only.
    const db = createDevicesDb({ devices: [seedDevice()] });
    const res = await request(db, '/_matrix/client/v3/devices/PHONE', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(401);
    const session = (res.body as { session: string }).session;
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('two UIA challenges without mock produce different sessions', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    const a = await request(db, '/_matrix/client/v3/devices/A', {
      method: 'DELETE',
      headers: AUTH,
    });
    const b = await request(db, '/_matrix/client/v3/devices/B', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect((a.body as { session: string }).session).not.toBe(
      (b.body as { session: string }).session
    );
  });
});
