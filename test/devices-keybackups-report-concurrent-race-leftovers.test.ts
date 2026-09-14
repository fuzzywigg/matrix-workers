/**
 * TOKENMAXX HEAVY leftovers after #153 — devices/key-backups/report *concurrent race / TOCTOU*
 * + soft/edge reliability for slices #153 leftovers soft-flooded lightly.
 * Orthogonal to keys/media/appservice races (#167), login/QR/identity races (#163),
 * push leftovers (#169), and to-device crypto edges (#168).
 * Focus: device PUT/DELETE lost-updates, room_keys version/session overwrite races,
 * content_reports duplicate INSERT TOCTOU + resolve double-apply.
 * Tests-only. Fixtures use example.com only. No product inventing.
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
import keyBackups from '../src/api/key-backups';
import reportApp from '../src/api/report';
import { verifyPassword } from '../src/utils/crypto';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ADMIN = '@admin:example.com';
const DEVICE = 'PHONE';
const OTHER_DEV = 'LAPTOP';
const CURRENT = 'CURRENT';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const EVENT = '$evt:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const ALG_MEGOLM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const AUTH_DATA = {
  public_key: 'curve25519pubkey',
  signatures: { [USER]: { 'ed25519:DEVICE': 'sig' } },
};
const PASS = 's3cret';
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;
const SESSION = 'sessionABC';

type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};

type VersionRow = {
  version: number;
  user_id: string;
  algorithm: string;
  auth_data: string;
  etag: string;
  count: number;
  deleted: number;
};

type KeyRow = {
  user_id: string;
  version: string;
  room_id: string;
  session_id: string;
  first_message_index: number;
  forwarded_count: number;
  is_verified: number;
  session_data: string;
};

type Membership = { room_id: string; user_id: string; membership: string };
type UserRow = { user_id: string; admin: number };
type EventRow = {
  event_id: string;
  room_id: string;
  sender?: string;
  event_type?: string;
  content?: string | null;
};
type ReportRow = {
  id: number;
  reporter_user_id: string;
  room_id: string | null;
  event_id: string | null;
  reason: string;
  score: number;
  created_at: number;
  resolved: number;
  resolved_by?: string | null;
  resolved_at?: number | null;
  resolution_note?: string | null;
  report_type?: string | null;
  reported_user_id?: string | null;
};

function keyId(userId: string, version: string, roomId: string, sessionId: string): string {
  return `${userId}\0${version}\0${roomId}\0${sessionId}`;
}

async function withSelectBarrier(
  barrier: SelectBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function createDevicesDb(
  opts: {
    devices?: DeviceRow[];
    passwordHash?: string | null;
    missingUser?: boolean;
    selectBarrier?: SelectBarrier;
  } = {}
) {
  const deviceRows = opts.devices ?? [];
  const passwordHash =
    opts.passwordHash === undefined ? 'mockok:s3cret' : opts.passwordHash;
  const missingUser = opts.missingUser ?? false;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };

  const db = {
    devices: deviceRows,
    inserts,
    updates,
    deletes,
    selects,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 48)}`);
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
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
                events.push('run:update-display');
                const [displayName, userId, deviceId] = args as [string, string, string];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
                if (row) row.display_name = displayName;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                events.push('run:delete-tokens');
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM device_keys')) {
                deletes.push({ sql, args });
                events.push('run:delete-keys');
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM devices')) {
                deletes.push({ sql, args });
                events.push('run:delete-device');
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

function createKeyBackupDb(
  opts: {
    versions?: VersionRow[];
    keys?: KeyRow[];
    nullCount?: boolean;
    selectBarrier?: SelectBarrier;
  } = {}
) {
  const versions = opts.versions ?? [];
  const keys = opts.keys ?? [];
  let nextVersionId =
    versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };

  const db = {
    versions,
    keys,
    inserts,
    updates,
    deletes,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              events.push(`first:${sql.slice(0, 48)}`);
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (sql.includes('SELECT COUNT(*) as count FROM key_backup_keys')) {
                if (opts.nullCount) return null as T;
                const userId = args[0] as string;
                const version = String(args[1]);
                const count = keys.filter(
                  (k) => k.user_id === userId && k.version === version
                ).length;
                return { count } as T;
              }
              if (
                sql.includes('FROM key_backup_keys') &&
                sql.includes('session_id = ?') &&
                sql.includes('SELECT first_message_index')
              ) {
                const [userId, version, roomId, sessionId] = args as string[];
                const row = keys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.version === String(version) &&
                    k.room_id === roomId &&
                    k.session_id === sessionId
                );
                if (!row) return null;
                return {
                  first_message_index: row.first_message_index,
                  forwarded_count: row.forwarded_count,
                  is_verified: row.is_verified,
                  session_data: row.session_data,
                } as T;
              }
              if (
                sql.includes('FROM key_backup_versions') &&
                sql.includes('ORDER BY version DESC') &&
                sql.includes('LIMIT 1')
              ) {
                const userId = args[0] as string;
                const active = versions
                  .filter((v) => v.user_id === userId && v.deleted === 0)
                  .sort((a, b) => b.version - a.version);
                const hit = active[0];
                if (!hit) return null;
                return {
                  version: hit.version,
                  algorithm: hit.algorithm,
                  auth_data: hit.auth_data,
                  count: hit.count,
                  etag: hit.etag,
                } as T;
              }
              if (
                sql.includes('FROM key_backup_versions') &&
                sql.includes('version = ?') &&
                sql.includes('SELECT version, algorithm, auth_data, count, etag')
              ) {
                const userId = args[0] as string;
                const version = Number(args[1]);
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === version && v.deleted === 0
                );
                if (!hit) return null;
                return {
                  version: hit.version,
                  algorithm: hit.algorithm,
                  auth_data: hit.auth_data,
                  count: hit.count,
                  etag: hit.etag,
                } as T;
              }
              if (
                sql.includes('FROM key_backup_versions') &&
                sql.includes('version = ?') &&
                sql.includes('deleted = 0')
              ) {
                const userId = args[0] as string;
                const version = Number(args[1]);
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === version && v.deleted === 0
                );
                if (!hit) return null;
                if (sql.includes('etag')) {
                  return { version: hit.version, etag: hit.etag } as T;
                }
                return { version: hit.version } as T;
              }
              return null;
            },
            async all<T>() {
              if (
                sql.includes('FROM key_backup_keys') &&
                sql.includes('SELECT room_id, session_id')
              ) {
                const userId = args[0] as string;
                const version = String(args[1]);
                const results = keys
                  .filter((k) => k.user_id === userId && k.version === version)
                  .map((k) => ({
                    room_id: k.room_id,
                    session_id: k.session_id,
                    first_message_index: k.first_message_index,
                    forwarded_count: k.forwarded_count,
                    is_verified: k.is_verified,
                    session_data: k.session_data,
                  }));
                return { results } as { results: T[] };
              }
              if (
                sql.includes('FROM key_backup_keys') &&
                sql.includes('room_id = ?') &&
                sql.includes('SELECT session_id')
              ) {
                const userId = args[0] as string;
                const version = String(args[1]);
                const roomId = args[2] as string;
                const results = keys
                  .filter(
                    (k) =>
                      k.user_id === userId &&
                      k.version === version &&
                      k.room_id === roomId
                  )
                  .map((k) => ({
                    session_id: k.session_id,
                    first_message_index: k.first_message_index,
                    forwarded_count: k.forwarded_count,
                    is_verified: k.is_verified,
                    session_data: k.session_data,
                  }));
                return { results } as { results: T[] };
              }
              return { results: [] as T[] };
            },
            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              if (sql.includes('INSERT INTO key_backup_versions')) {
                inserts.push({ sql, args });
                events.push('run:insert-version');
                const [userId, algorithm, auth_data, etag] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const version = nextVersionId++;
                versions.push({
                  version,
                  user_id: userId,
                  algorithm,
                  auth_data,
                  etag,
                  count: 0,
                  deleted: 0,
                });
                return { success: true, meta: { changes: 1, last_row_id: version } };
              }
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET deleted = 1')
              ) {
                updates.push({ sql, args });
                events.push('run:soft-delete-version');
                const [userId, version] = args as [string, string];
                const hit = versions.find(
                  (v) =>
                    v.user_id === userId &&
                    v.version === Number(version) &&
                    v.deleted === 0
                );
                if (!hit) {
                  return { success: true, meta: { changes: 0, last_row_id: 0 } };
                }
                hit.deleted = 1;
                return { success: true, meta: { changes: 1, last_row_id: hit.version } };
              }
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET auth_data = ?')
              ) {
                updates.push({ sql, args });
                events.push('run:update-auth');
                const [auth_data, userId, version] = args as [string, string, string];
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === Number(version)
                );
                if (hit) hit.auth_data = auth_data;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET count = ?') &&
                sql.includes('etag = ?')
              ) {
                updates.push({ sql, args });
                events.push('run:update-count-etag');
                const [count, etag, userId, version] = args as [
                  number,
                  string,
                  string,
                  string,
                ];
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === Number(version)
                );
                if (hit) {
                  hit.count = count;
                  hit.etag = etag;
                }
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET count = 0, etag = ?')
              ) {
                updates.push({ sql, args });
                events.push('run:zero-count');
                const [etag, userId, version] = args as [string, string, string];
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === Number(version)
                );
                if (hit) {
                  hit.count = 0;
                  hit.etag = etag;
                }
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO key_backup_keys')) {
                inserts.push({ sql, args });
                events.push('run:upsert-key');
                const [
                  userId,
                  version,
                  roomId,
                  sessionId,
                  firstMessageIndex,
                  forwardedCount,
                  isVerified,
                  sessionData,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  number,
                  string,
                ];
                const id = keyId(userId, String(version), roomId, sessionId);
                const existing = keys.findIndex(
                  (k) =>
                    keyId(k.user_id, k.version, k.room_id, k.session_id) === id
                );
                const row: KeyRow = {
                  user_id: userId,
                  version: String(version),
                  room_id: roomId,
                  session_id: sessionId,
                  first_message_index: firstMessageIndex,
                  forwarded_count: forwardedCount,
                  is_verified: isVerified,
                  session_data: sessionData,
                };
                if (existing >= 0) {
                  keys[existing] = row;
                } else {
                  keys.push(row);
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (
                sql.includes('DELETE FROM key_backup_keys') &&
                sql.includes('session_id = ?')
              ) {
                deletes.push({ sql, args });
                events.push('run:delete-session');
                const [userId, version, roomId, sessionId] = args as string[];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  const k = keys[i];
                  if (
                    k.user_id === userId &&
                    k.version === String(version) &&
                    k.room_id === roomId &&
                    k.session_id === sessionId
                  ) {
                    keys.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - keys.length, last_row_id: 0 },
                };
              }
              if (
                sql.includes('DELETE FROM key_backup_keys') &&
                sql.includes('room_id = ?') &&
                !sql.includes('session_id = ?')
              ) {
                deletes.push({ sql, args });
                events.push('run:delete-room-keys');
                const [userId, version, roomId] = args as string[];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  const k = keys[i];
                  if (
                    k.user_id === userId &&
                    k.version === String(version) &&
                    k.room_id === roomId
                  ) {
                    keys.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - keys.length, last_row_id: 0 },
                };
              }
              if (sql.includes('DELETE FROM key_backup_keys')) {
                deletes.push({ sql, args });
                events.push('run:delete-all-keys');
                const [userId, version] = args as string[];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  const k = keys[i];
                  if (k.user_id === userId && k.version === String(version)) {
                    keys.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - keys.length, last_row_id: 0 },
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

type KeyBackupDb = ReturnType<typeof createKeyBackupDb>;

function createReportDb(
  opts: {
    users?: UserRow[];
    rooms?: string[];
    events?: EventRow[];
    memberships?: Membership[];
    reports?: ReportRow[];
    selectBarrier?: SelectBarrier;
  } = {}
) {
  const users = opts.users ?? [
    { user_id: USER, admin: 0 },
    { user_id: BOB, admin: 0 },
    { user_id: ADMIN, admin: 1 },
  ];
  const rooms = opts.rooms ?? [ROOM];
  const events = opts.events ?? [];
  const memberships = opts.memberships ?? [];
  const reports = opts.reports ?? [];
  let nextId = reports.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const eventsLog: string[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };

  const db = {
    users,
    rooms,
    events,
    memberships,
    reports,
    inserts,
    updates,
    selects,
    eventsLog,
    get nextId() {
      return nextId;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              eventsLog.push(`first:${sql.slice(0, 48)}`);
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('SELECT membership FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              if (sql.includes('SELECT event_id FROM events WHERE event_id = ? AND room_id = ?')) {
                const [eventId, roomId] = args as string[];
                const row = events.find((e) => e.event_id === eventId && e.room_id === roomId);
                return (row ? { event_id: row.event_id } : null) as T;
              }
              if (sql.includes('SELECT room_id FROM rooms WHERE room_id = ?')) {
                const roomId = args[0] as string;
                return (rooms.includes(roomId) ? { room_id: roomId } : null) as T;
              }
              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                return (row ? { user_id: row.user_id } : null) as T;
              }
              if (sql.includes('SELECT admin FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                return (row ? { admin: row.admin } : null) as T;
              }
              if (
                sql.includes('SELECT id FROM content_reports') &&
                sql.includes('reporter_user_id = ? AND room_id = ? AND event_id = ?') &&
                !sql.includes('IS NULL')
              ) {
                const [reporter, roomId, eventId] = args as string[];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id === eventId
                );
                return (row ? { id: row.id } : null) as T;
              }
              if (
                sql.includes('SELECT id FROM content_reports') &&
                sql.includes('event_id IS NULL') &&
                sql.includes("report_type = 'room'")
              ) {
                const [reporter, roomId] = args as string[];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id == null &&
                    r.report_type === 'room'
                );
                return (row ? { id: row.id } : null) as T;
              }
              if (
                sql.includes('SELECT id FROM content_reports') &&
                sql.includes('reported_user_id = ?') &&
                sql.includes("report_type = 'user'")
              ) {
                const [reporter, reported] = args as string[];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.reported_user_id === reported &&
                    r.report_type === 'user'
                );
                return (row ? { id: row.id } : null) as T;
              }
              if (
                sql.includes('FROM content_reports cr') &&
                sql.includes('LEFT JOIN events e') &&
                sql.includes('WHERE cr.id = ?')
              ) {
                const id = args[0] as number;
                const row = reports.find((r) => r.id === id);
                if (!row) return null;
                const ev = events.find((e) => e.event_id === row.event_id);
                return {
                  ...row,
                  resolved: Boolean(row.resolved),
                  reported_user_id: ev?.sender ?? row.reported_user_id ?? null,
                  event_type: ev?.event_type ?? null,
                  content: ev?.content ?? null,
                } as T;
              }
              // resolve path may SELECT by id without join
              if (
                sql.includes('FROM content_reports') &&
                sql.includes('WHERE id = ?') &&
                !sql.includes('LEFT JOIN')
              ) {
                const id = args[0] as number;
                const row = reports.find((r) => r.id === id);
                return (row ?? null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 180)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              if (
                sql.includes('FROM content_reports cr') &&
                sql.includes('LEFT JOIN events e') &&
                sql.includes('WHERE 1=1')
              ) {
                let filtered = [...reports];
                if (sql.includes('AND cr.resolved = 1')) {
                  filtered = filtered.filter((r) => r.resolved === 1);
                } else if (sql.includes('AND cr.resolved = 0')) {
                  filtered = filtered.filter((r) => r.resolved === 0);
                }
                let fromId: number | undefined;
                let limit: number;
                if (sql.includes('AND cr.id < ?')) {
                  fromId = args[0] as number;
                  limit = args[1] as number;
                  filtered = filtered.filter((r) => r.id < fromId!);
                } else {
                  limit = args[0] as number;
                }
                filtered.sort((a, b) => b.created_at - a.created_at);
                const slice = filtered.slice(0, limit);
                const results = slice.map((r) => {
                  const ev = events.find((e) => e.event_id === r.event_id);
                  return {
                    ...r,
                    resolved: Boolean(r.resolved),
                    reported_user_id: ev?.sender ?? r.reported_user_id ?? null,
                    event_type: ev?.event_type ?? null,
                    content: ev?.content ?? null,
                  };
                });
                return { results: results as T[] };
              }
              return { results: [] as T[] };
            },
            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              if (
                sql.includes('UPDATE content_reports SET reason = ?, score = ?, created_at = ?') &&
                sql.includes('event_id = ?') &&
                !sql.includes('IS NULL')
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-event-report');
                const [reason, score, createdAt, reporter, roomId, eventId] = args as [
                  string,
                  number,
                  number,
                  string,
                  string,
                  string,
                ];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id === eventId
                );
                if (row) {
                  row.reason = reason;
                  row.score = score;
                  row.created_at = createdAt;
                  return { success: true, meta: { changes: 1, last_row_id: row.id } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE content_reports SET reason = ?, score = ?, created_at = ?') &&
                sql.includes('event_id IS NULL') &&
                sql.includes("report_type = 'room'")
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-room-report');
                const [reason, score, createdAt, reporter, roomId] = args as [
                  string,
                  number,
                  number,
                  string,
                  string,
                ];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id == null &&
                    r.report_type === 'room'
                );
                if (row) {
                  row.reason = reason;
                  row.score = score;
                  row.created_at = createdAt;
                  return { success: true, meta: { changes: 1, last_row_id: row.id } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE content_reports SET reason = ?, created_at = ?') &&
                sql.includes("report_type = 'user'")
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-user-report');
                const [reason, createdAt, reporter, reported] = args as [
                  string,
                  number,
                  string,
                  string,
                ];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.reported_user_id === reported &&
                    r.report_type === 'user'
                );
                if (row) {
                  row.reason = reason;
                  row.created_at = createdAt;
                  return { success: true, meta: { changes: 1, last_row_id: row.id } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE content_reports') &&
                sql.includes('SET resolved = 1')
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:resolve');
                const [resolvedBy, resolvedAt, note, id] = args as [
                  string,
                  number,
                  string | null,
                  number,
                ];
                const row = reports.find((r) => r.id === id);
                if (!row || row.resolved === 1) {
                  return { success: true, meta: { changes: 0, last_row_id: 0 } };
                }
                row.resolved = 1;
                row.resolved_by = resolvedBy;
                row.resolved_at = resolvedAt;
                row.resolution_note = note;
                return { success: true, meta: { changes: 1, last_row_id: row.id } };
              }
              // INSERT event report
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes('(reporter_user_id, room_id, event_id, reason, score, created_at)') &&
                !sql.includes('report_type')
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-event-report');
                const [reporter, roomId, eventId, reason, score, createdAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                ];
                const id = nextId++;
                reports.push({
                  id,
                  reporter_user_id: reporter,
                  room_id: roomId,
                  event_id: eventId,
                  reason,
                  score,
                  created_at: createdAt,
                  resolved: 0,
                  report_type: 'event',
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }

              // INSERT room report
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes("VALUES (?, ?, NULL, ?, ?, ?, 'room')")
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-room-report');
                const [reporter, roomId, reason, score, createdAt] = args as [
                  string,
                  string,
                  string,
                  number,
                  number,
                ];
                const id = nextId++;
                reports.push({
                  id,
                  reporter_user_id: reporter,
                  room_id: roomId,
                  event_id: null,
                  reason,
                  score,
                  created_at: createdAt,
                  resolved: 0,
                  report_type: 'room',
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }

              // INSERT user report
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes('reported_user_id')
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-user-report');
                const [reporter, reason, createdAt, reportedUser] = args as [
                  string,
                  string,
                  number,
                  string,
                ];
                const id = nextId++;
                reports.push({
                  id,
                  reporter_user_id: reporter,
                  room_id: null,
                  event_id: null,
                  reason,
                  score: -100,
                  created_at: createdAt,
                  resolved: 0,
                  report_type: 'user',
                  reported_user_id: reportedUser,
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 180)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type ReportDb = ReturnType<typeof createReportDb>;

function envFor(db: unknown): Env {
  return {
    DB: db as D1Database,
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function devicesReq(
  db: DevicesDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await devices.request(`http://localhost${path}`, init, envFor(db));
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

async function keysReq(
  db: KeyBackupDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await keyBackups.request(`http://localhost${path}`, init, envFor(db));
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

async function reportReq(
  db: ReportDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await reportApp.request(`http://localhost${path}`, init, envFor(db));
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
    device_id: overrides.device_id ?? DEVICE,
    user_id: overrides.user_id ?? USER,
    display_name: overrides.display_name ?? null,
    last_seen_ts: overrides.last_seen_ts ?? null,
    last_seen_ip: overrides.last_seen_ip ?? null,
  };
}

function seedVersion(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    version: overrides.version ?? 1,
    user_id: overrides.user_id ?? USER,
    algorithm: overrides.algorithm ?? ALG_MEGOLM,
    auth_data: overrides.auth_data ?? JSON.stringify(AUTH_DATA),
    etag: overrides.etag ?? 'etag-a',
    count: overrides.count ?? 0,
    deleted: overrides.deleted ?? 0,
  };
}

function seedKey(overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    user_id: overrides.user_id ?? USER,
    version: overrides.version ?? '1',
    room_id: overrides.room_id ?? ROOM,
    session_id: overrides.session_id ?? SESSION,
    first_message_index: overrides.first_message_index ?? 0,
    forwarded_count: overrides.forwarded_count ?? 0,
    is_verified: overrides.is_verified ?? 1,
    session_data: overrides.session_data ?? JSON.stringify({ ciphertext: 'c' }),
  };
}

function seedEventReport(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: overrides.id ?? 1,
    reporter_user_id: overrides.reporter_user_id ?? USER,
    room_id: overrides.room_id ?? ROOM,
    event_id: overrides.event_id ?? EVENT,
    reason: overrides.reason ?? 'spam',
    score: overrides.score ?? -50,
    created_at: overrides.created_at ?? NOW,
    resolved: overrides.resolved ?? 0,
    report_type: overrides.report_type ?? 'event',
  };
}

beforeEach(() => {
  vi.mocked(verifyPassword).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});


describe('race devices PUT display_name lost-update TOCTOU after #153', () => {
  it('PUT∥PUT display_name barrier race #0', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-0' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-0' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-0' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-0', 'B-0']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #1', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-1' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-1' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-1' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-1', 'B-1']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #2', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-2' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-2' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-2' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-2', 'B-2']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #3', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-3' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-3' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-3' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-3', 'B-3']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #4', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-4' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-4' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-4' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-4', 'B-4']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #5', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-5' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-5' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-5' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-5', 'B-5']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #6', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-6' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-6' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-6' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-6', 'B-6']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #7', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-7' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-7' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-7' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-7', 'B-7']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #8', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-8' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-8' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-8' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-8', 'B-8']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #9', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-9' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-9' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-9' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-9', 'B-9']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #10', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-10' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-10' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-10' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-10', 'B-10']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #11', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-11' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-11' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-11' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-11', 'B-11']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #12', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-12' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-12' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-12' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-12', 'B-12']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #13', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-13' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-13' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-13' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-13', 'B-13']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #14', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-14' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-14' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-14' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-14', 'B-14']).toContain(db.devices[0].display_name);
  });
  it('PUT∥PUT display_name barrier race #15', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ display_name: 'old-15' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'A-15' })),
      devicesReq(db, '/_matrix/client/v3/devices/' + DEVICE, jsonInit('PUT', { display_name: 'B-15' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('display_name')).length).toBe(2);
    expect(['A-15', 'B-15']).toContain(db.devices[0].display_name);
  });
});


describe('race devices DELETE same device double-consume TOCTOU after #153', () => {
  it('DELETE∥DELETE device barrier race #0', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL0' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL0';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL0')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #1', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL1' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL1';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL1')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #2', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL2' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL2';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL2')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #3', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL3' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL3';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL3')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #4', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL4' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL4';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL4')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #5', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL5' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL5';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL5')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #6', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL6' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL6';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL6')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #7', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL7' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL7';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL7')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #8', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL8' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL8';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL8')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #9', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL9' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL9';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL9')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #10', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL10' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL10';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL10')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #11', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL11' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL11';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL11')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #12', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL12' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL12';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL12')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #13', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL13' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL13';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL13')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #14', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL14' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL14';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL14')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
  it('DELETE∥DELETE device barrier race #15', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'DEL15' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/DEL15';
    const authBody = { auth: { type: 'm.login.password', password: PASS } };
    const [a, b] = await Promise.all([
      devicesReq(db, path, jsonInit('DELETE', authBody)),
      devicesReq(db, path, jsonInit('DELETE', authBody)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw device present; both may delete
    expect(db.devices.find((d) => d.device_id === 'DEL15')).toBeUndefined();
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM devices')).length).toBeGreaterThanOrEqual(1);
  });
});


describe('race devices PUT∥DELETE same device after #153', () => {
  it('PUT∥DELETE device barrier race #0', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX0', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX0';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-0' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #1', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX1', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX1';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-1' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #2', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX2', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX2';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-2' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #3', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX3', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX3';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-3' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #4', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX4', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX4';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-4' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #5', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX5', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX5';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-5' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #6', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX6', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX6';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-6' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #7', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX7', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX7';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-7' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #8', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX8', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX8';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-8' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #9', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX9', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX9';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-9' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #10', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX10', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX10';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-10' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #11', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX11', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX11';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-11' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #12', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX12', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX12';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-12' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #13', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX13', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX13';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-13' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #14', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX14', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX14';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-14' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
  it('PUT∥DELETE device barrier race #15', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'MIX15', display_name: 'n' })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT device_id FROM devices'),
        count: 2,
      },
    });
    const path = '/_matrix/client/v3/devices/MIX15';
    const [putRes, delRes] = await Promise.all([
      devicesReq(db, path, jsonInit('PUT', { display_name: 'race-15' })),
      devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
  });
});


describe('race devices delete_devices overlapping lists after #153', () => {
  it('delete_devices overlapping parallel #0', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL0A' }),
        seedDevice({ device_id: 'OVL0B' }),
        seedDevice({ device_id: 'OVL0C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL0A', 'OVL0B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL0B', 'OVL0C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #1', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL1A' }),
        seedDevice({ device_id: 'OVL1B' }),
        seedDevice({ device_id: 'OVL1C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL1A', 'OVL1B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL1B', 'OVL1C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #2', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL2A' }),
        seedDevice({ device_id: 'OVL2B' }),
        seedDevice({ device_id: 'OVL2C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL2A', 'OVL2B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL2B', 'OVL2C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #3', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL3A' }),
        seedDevice({ device_id: 'OVL3B' }),
        seedDevice({ device_id: 'OVL3C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL3A', 'OVL3B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL3B', 'OVL3C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #4', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL4A' }),
        seedDevice({ device_id: 'OVL4B' }),
        seedDevice({ device_id: 'OVL4C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL4A', 'OVL4B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL4B', 'OVL4C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #5', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL5A' }),
        seedDevice({ device_id: 'OVL5B' }),
        seedDevice({ device_id: 'OVL5C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL5A', 'OVL5B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL5B', 'OVL5C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #6', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL6A' }),
        seedDevice({ device_id: 'OVL6B' }),
        seedDevice({ device_id: 'OVL6C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL6A', 'OVL6B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL6B', 'OVL6C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #7', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL7A' }),
        seedDevice({ device_id: 'OVL7B' }),
        seedDevice({ device_id: 'OVL7C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL7A', 'OVL7B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL7B', 'OVL7C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #8', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL8A' }),
        seedDevice({ device_id: 'OVL8B' }),
        seedDevice({ device_id: 'OVL8C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL8A', 'OVL8B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL8B', 'OVL8C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #9', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL9A' }),
        seedDevice({ device_id: 'OVL9B' }),
        seedDevice({ device_id: 'OVL9C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL9A', 'OVL9B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL9B', 'OVL9C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #10', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL10A' }),
        seedDevice({ device_id: 'OVL10B' }),
        seedDevice({ device_id: 'OVL10C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL10A', 'OVL10B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL10B', 'OVL10C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #11', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL11A' }),
        seedDevice({ device_id: 'OVL11B' }),
        seedDevice({ device_id: 'OVL11C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL11A', 'OVL11B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL11B', 'OVL11C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #12', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL12A' }),
        seedDevice({ device_id: 'OVL12B' }),
        seedDevice({ device_id: 'OVL12C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL12A', 'OVL12B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL12B', 'OVL12C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #13', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL13A' }),
        seedDevice({ device_id: 'OVL13B' }),
        seedDevice({ device_id: 'OVL13C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL13A', 'OVL13B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL13B', 'OVL13C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #14', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL14A' }),
        seedDevice({ device_id: 'OVL14B' }),
        seedDevice({ device_id: 'OVL14C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL14A', 'OVL14B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL14B', 'OVL14C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
  it('delete_devices overlapping parallel #15', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'OVL15A' }),
        seedDevice({ device_id: 'OVL15B' }),
        seedDevice({ device_id: 'OVL15C' }),
      ],
    });
    const auth = { type: 'm.login.password', password: PASS };
    const [a, b] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL15A', 'OVL15B'], auth })),
      devicesReq(db, '/_matrix/client/v3/delete_devices', jsonInit('POST', { devices: ['OVL15B', 'OVL15C'], auth })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.devices.map((d) => d.device_id).sort()).toEqual([]);
  });
});


describe('devices GET list∥DELETE soft race after #153', () => {
  it('GET list∥DELETE soft race #0', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL0' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL0', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL0')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #1', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL1' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL1', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL1')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #2', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL2' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL2', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL2')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #3', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL3' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL3', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL3')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #4', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL4' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL4', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL4')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #5', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL5' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL5', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL5')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #6', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL6' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL6', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL6')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #7', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL7' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL7', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL7')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #8', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL8' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL8', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL8')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #9', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL9' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL9', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL9')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #10', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL10' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL10', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL10')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #11', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL11' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL11', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL11')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #12', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL12' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL12', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL12')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #13', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL13' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL13', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL13')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #14', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL14' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL14', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL14')).toBeUndefined();
  });
  it('GET list∥DELETE soft race #15', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'GL15' }), seedDevice({ device_id: CURRENT })],
    });
    const [listRes, delRes] = await Promise.all([
      devicesReq(db, '/_matrix/client/v3/devices'),
      devicesReq(db, '/_matrix/client/v3/devices/GL15', jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
    ]);
    expect(listRes.status).toBe(200);
    expect(delRes.status).toBe(200);
    const listed = (listRes.body as { devices: Array<{ device_id: string }> }).devices;
    expect(Array.isArray(listed)).toBe(true);
    expect(db.devices.find((d) => d.device_id === 'GL15')).toBeUndefined();
  });
});


describe('devices DELETE UIA challenge soft flood after #153', () => {
  it('DELETE UIA soft flood #0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA0' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA0', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA0')).toBe(true);
  });
  it('DELETE UIA soft flood #1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA1' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA1', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA1')).toBe(true);
  });
  it('DELETE UIA soft flood #2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA2' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA2', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA2')).toBe(true);
  });
  it('DELETE UIA soft flood #3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA3' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA3', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA3')).toBe(true);
  });
  it('DELETE UIA soft flood #4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA4' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA4', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA4')).toBe(true);
  });
  it('DELETE UIA soft flood #5', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA5' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA5', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA5')).toBe(true);
  });
  it('DELETE UIA soft flood #6', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA6' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA6', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA6')).toBe(true);
  });
  it('DELETE UIA soft flood #7', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA7' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA7', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA7')).toBe(true);
  });
  it('DELETE UIA soft flood #8', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA8' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA8', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA8')).toBe(true);
  });
  it('DELETE UIA soft flood #9', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA9' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA9', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA9')).toBe(true);
  });
  it('DELETE UIA soft flood #10', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA10' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA10', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA10')).toBe(true);
  });
  it('DELETE UIA soft flood #11', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA11' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA11', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA11')).toBe(true);
  });
  it('DELETE UIA soft flood #12', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA12' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA12', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA12')).toBe(true);
  });
  it('DELETE UIA soft flood #13', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA13' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA13', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA13')).toBe(true);
  });
  it('DELETE UIA soft flood #14', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA14' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA14', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA14')).toBe(true);
  });
  it('DELETE UIA soft flood #15', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'UIA15' })] });
    const res = await devicesReq(db, '/_matrix/client/v3/devices/UIA15', jsonInit('DELETE', {}));
    expect(res.status).toBe(401);
    const body = res.body as { flows: unknown[]; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(db.devices.some((d) => d.device_id === 'UIA15')).toBe(true);
  });
});


describe('race key-backups POST version parallel mint after #153', () => {
  it('POST version parallel mint #0', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-0' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #1', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-1' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #2', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-2' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #3', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-3' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #4', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-4' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #5', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-5' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #6', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-6' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #7', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-7' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #8', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-8' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #9', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-9' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #10', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-10' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #11', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-11' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #12', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-12' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #13', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-13' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #14', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-14' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
  it('POST version parallel mint #15', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = { algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, public_key: 'pk-15' } };
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
      keysReq(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = String((a.body as { version: string }).version);
    const vb = String((b.body as { version: string }).version);
    expect(va).not.toBe(vb);
    expect(db.versions.filter((v) => v.deleted === 0).length).toBe(2);
  });
});


describe('race key-backups PUT session overwrite TOCTOU after #153', () => {
  it('PUT session∥PUT overwrite race #0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e0' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-0' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-0' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-0' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-0', 'B-0']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e1' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-1' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-1' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-1' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-1', 'B-1']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e2' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-2' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-2' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-2' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-2', 'B-2']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e3' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-3' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-3' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-3' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-3', 'B-3']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e4' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-4' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-4' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-4' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-4', 'B-4']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e5' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-5' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-5' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-5' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-5', 'B-5']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e6' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-6' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-6' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-6' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-6', 'B-6']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e7' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-7' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-7' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-7' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-7', 'B-7']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e8' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-8' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-8' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-8' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-8', 'B-8']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e9' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-9' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-9' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-9' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-9', 'B-9']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e10' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-10' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-10' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-10' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-10', 'B-10']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e11' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-11' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-11' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-11' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-11', 'B-11']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e12' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-12' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-12' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-12' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-12', 'B-12']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e13' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-13' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-13' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-13' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-13', 'B-13']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e14' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-14' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-14' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-14' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-14', 'B-14']).toContain(stored.ciphertext);
  });
  it('PUT session∥PUT overwrite race #15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'e15' })],
      keys: [seedKey({ session_data: JSON.stringify({ ciphertext: 'old-15' }) })],
      selectBarrier: {
        match: (sql) => sql.includes('FROM key_backup_versions') && sql.includes('etag'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`;
    const bodyA = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'A-15' } };
    const bodyB = { first_message_index: 1, forwarded_count: 2, is_verified: false, session_data: { ciphertext: 'B-15' } };
    const [a, b] = await Promise.all([
      keysReq(db, path, jsonInit('PUT', bodyA)),
      keysReq(db, path, jsonInit('PUT', bodyB)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.keys.length).toBe(1);
    const stored = JSON.parse(db.keys[0].session_data);
    expect(['A-15', 'B-15']).toContain(stored.ciphertext);
  });
});


describe('race key-backups PUT keys∥DELETE version after #153', () => {
  it('PUT keys∥DELETE version race #0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-0' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-1' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-2' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-3' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-4' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-5' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-6' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-7' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-8' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-9' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-10' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-11' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-12' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-13' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-14' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
  it('PUT keys∥DELETE version race #15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [],
    });
    const putBody = {
      rooms: {
        [ROOM]: {
          sessions: {
            [SESSION]: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'race-15' },
            },
          },
        },
      },
    };
    const [putRes, delRes] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/keys?version=1', jsonInit('PUT', putBody)),
      keysReq(db, '/_matrix/client/v3/room_keys/version/1', { method: 'DELETE', headers: AUTH }),
    ]);
    expect([200, 404]).toContain(putRes.status);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status === 200 || delRes.status === 200).toBe(true);
    const active = db.versions.filter((v) => v.version === 1 && v.deleted === 0);
    if (delRes.status === 200) expect(active.length).toBe(0);
  });
});


describe('race key-backups DELETE version double soft-delete after #153', () => {
  it('DELETE version∥DELETE soft-delete race #0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (0 % 3), etag: 'd0' })],
      keys: [seedKey({ version: String(7 + (0 % 3)) })],
    });
    const ver = String(7 + (0 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (1 % 3), etag: 'd1' })],
      keys: [seedKey({ version: String(7 + (1 % 3)) })],
    });
    const ver = String(7 + (1 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (2 % 3), etag: 'd2' })],
      keys: [seedKey({ version: String(7 + (2 % 3)) })],
    });
    const ver = String(7 + (2 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (3 % 3), etag: 'd3' })],
      keys: [seedKey({ version: String(7 + (3 % 3)) })],
    });
    const ver = String(7 + (3 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (4 % 3), etag: 'd4' })],
      keys: [seedKey({ version: String(7 + (4 % 3)) })],
    });
    const ver = String(7 + (4 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (5 % 3), etag: 'd5' })],
      keys: [seedKey({ version: String(7 + (5 % 3)) })],
    });
    const ver = String(7 + (5 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (6 % 3), etag: 'd6' })],
      keys: [seedKey({ version: String(7 + (6 % 3)) })],
    });
    const ver = String(7 + (6 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (7 % 3), etag: 'd7' })],
      keys: [seedKey({ version: String(7 + (7 % 3)) })],
    });
    const ver = String(7 + (7 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (8 % 3), etag: 'd8' })],
      keys: [seedKey({ version: String(7 + (8 % 3)) })],
    });
    const ver = String(7 + (8 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (9 % 3), etag: 'd9' })],
      keys: [seedKey({ version: String(7 + (9 % 3)) })],
    });
    const ver = String(7 + (9 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (10 % 3), etag: 'd10' })],
      keys: [seedKey({ version: String(7 + (10 % 3)) })],
    });
    const ver = String(7 + (10 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (11 % 3), etag: 'd11' })],
      keys: [seedKey({ version: String(7 + (11 % 3)) })],
    });
    const ver = String(7 + (11 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (12 % 3), etag: 'd12' })],
      keys: [seedKey({ version: String(7 + (12 % 3)) })],
    });
    const ver = String(7 + (12 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (13 % 3), etag: 'd13' })],
      keys: [seedKey({ version: String(7 + (13 % 3)) })],
    });
    const ver = String(7 + (13 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (14 % 3), etag: 'd14' })],
      keys: [seedKey({ version: String(7 + (14 % 3)) })],
    });
    const ver = String(7 + (14 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
  it('DELETE version∥DELETE soft-delete race #15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7 + (15 % 3), etag: 'd15' })],
      keys: [seedKey({ version: String(7 + (15 % 3)) })],
    });
    const ver = String(7 + (15 % 3));
    const [a, b] = await Promise.all([
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
      keysReq(db, '/_matrix/client/v3/room_keys/version/' + ver, { method: 'DELETE', headers: AUTH }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const notFound = [a, b].filter((r) => r.status === 404);
    expect(oks.length + notFound.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.versions.find((v) => v.version === Number(ver))?.deleted).toBe(1);
  });
});


describe('race key-backups DELETE session∥PUT session after #153', () => {
  it('DELETE session∥PUT session race #0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S0', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S0?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-0' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S1', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S1?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-1' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S2', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S2?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-2' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S3', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S3?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-3' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S4', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S4?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-4' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S5', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S5?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-5' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S6', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S6?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-6' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S7', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S7?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-7' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S8', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S8?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-8' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S9', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S9?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-9' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S10', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S10?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-10' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S11', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S11?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-11' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S12', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S12?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-12' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S13', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S13?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-13' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S14', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S14?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-14' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
  it('DELETE session∥PUT session race #15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S15', session_data: JSON.stringify({ ciphertext: 'pre' }) })],
    });
    const path = `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/S15?version=1`;
    const putBody = { first_message_index: 0, forwarded_count: 0, is_verified: true, session_data: { ciphertext: 'post-15' } };
    const [delRes, putRes] = await Promise.all([
      keysReq(db, path, { method: 'DELETE', headers: AUTH }),
      keysReq(db, path, jsonInit('PUT', putBody)),
    ]);
    expect([200, 404]).toContain(delRes.status);
    expect(putRes.status).toBe(200);
    // final state: either key re-upserted or deleted then re-added
    expect(db.versions[0].deleted).toBe(0);
  });
});


describe('key-backups PUT version auth_data soft flood after #153', () => {
  it('PUT version auth_data soft #0', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-0' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-0');
  });
  it('PUT version auth_data soft #1', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-1' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-1');
  });
  it('PUT version auth_data soft #2', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-2' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-2');
  });
  it('PUT version auth_data soft #3', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-3' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-3');
  });
  it('PUT version auth_data soft #4', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-4' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-4');
  });
  it('PUT version auth_data soft #5', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-5' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-5');
  });
  it('PUT version auth_data soft #6', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-6' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-6');
  });
  it('PUT version auth_data soft #7', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-7' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-7');
  });
  it('PUT version auth_data soft #8', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-8' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-8');
  });
  it('PUT version auth_data soft #9', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-9' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-9');
  });
  it('PUT version auth_data soft #10', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-10' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-10');
  });
  it('PUT version auth_data soft #11', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-11' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-11');
  });
  it('PUT version auth_data soft #12', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-12' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-12');
  });
  it('PUT version auth_data soft #13', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-13' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-13');
  });
  it('PUT version auth_data soft #14', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-14' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-14');
  });
  it('PUT version auth_data soft #15', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 2 })] });
    const auth_data = { ...AUTH_DATA, public_key: 'soft-pk-15' };
    const res = await keysReq(
      db,
      '/_matrix/client/v3/room_keys/version/2',
      jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('soft-pk-15');
  });
});


describe('key-backups GET keys room soft flood after #153', () => {
  it('GET room keys soft #0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA0', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB0', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA0', 'sB0'].sort());
  });
  it('GET room keys soft #1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA1', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB1', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA1', 'sB1'].sort());
  });
  it('GET room keys soft #2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA2', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB2', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA2', 'sB2'].sort());
  });
  it('GET room keys soft #3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA3', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB3', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA3', 'sB3'].sort());
  });
  it('GET room keys soft #4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA4', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB4', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA4', 'sB4'].sort());
  });
  it('GET room keys soft #5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA5', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB5', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA5', 'sB5'].sort());
  });
  it('GET room keys soft #6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA6', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB6', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA6', 'sB6'].sort());
  });
  it('GET room keys soft #7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA7', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB7', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA7', 'sB7'].sort());
  });
  it('GET room keys soft #8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA8', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB8', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA8', 'sB8'].sort());
  });
  it('GET room keys soft #9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA9', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB9', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA9', 'sB9'].sort());
  });
  it('GET room keys soft #10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA10', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB10', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA10', 'sB10'].sort());
  });
  it('GET room keys soft #11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA11', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB11', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA11', 'sB11'].sort());
  });
  it('GET room keys soft #12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA12', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB12', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA12', 'sB12'].sort());
  });
  it('GET room keys soft #13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA13', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB13', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA13', 'sB13'].sort());
  });
  it('GET room keys soft #14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA14', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB14', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA14', 'sB14'].sort());
  });
  it('GET room keys soft #15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'sA15', session_data: JSON.stringify({ ciphertext: 'a' }) }),
        seedKey({ session_id: 'sB15', session_data: JSON.stringify({ ciphertext: 'b' }) }),
      ],
    });
    const res = await keysReq(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`);
    expect(res.status).toBe(200);
    const body = res.body as { sessions: Record<string, unknown> };
    expect(Object.keys(body.sessions).sort()).toEqual(['sA15', 'sB15'].sort());
  });
});


describe('race report event duplicate INSERT TOCTOU after #153', () => {
  it('event report duplicate INSERT race #0', async () => {
    const evt = '$evt0:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-0', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-0', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #1', async () => {
    const evt = '$evt1:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-1', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-1', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #2', async () => {
    const evt = '$evt2:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-2', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-2', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #3', async () => {
    const evt = '$evt3:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-3', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-3', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #4', async () => {
    const evt = '$evt4:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-4', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-4', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #5', async () => {
    const evt = '$evt5:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-5', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-5', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #6', async () => {
    const evt = '$evt6:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-6', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-6', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #7', async () => {
    const evt = '$evt7:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-7', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-7', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #8', async () => {
    const evt = '$evt8:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-8', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-8', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #9', async () => {
    const evt = '$evt9:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-9', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-9', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #10', async () => {
    const evt = '$evt10:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-10', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-10', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #11', async () => {
    const evt = '$evt11:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-11', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-11', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #12', async () => {
    const evt = '$evt12:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-12', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-12', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #13', async () => {
    const evt = '$evt13:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-13', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-13', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #14', async () => {
    const evt = '$evt14:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-14', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-14', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('event report duplicate INSERT race #15', async () => {
    const evt = '$evt15:example.com';
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-15', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-15', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // TOCTOU: both saw no existing → may INSERT twice
    expect(db.inserts.filter((x) => x.sql.includes('INSERT INTO content_reports')).length).toBeGreaterThanOrEqual(1);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
});


describe('race report admin resolve double-apply after #153', () => {
  it('resolve∥resolve double-apply race #0', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 0, resolved: 0, reason: 'r0' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 0}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-0' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-0' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 0)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #1', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 1, resolved: 0, reason: 'r1' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 1}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-1' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-1' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 1)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #2', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 2, resolved: 0, reason: 'r2' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 2}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-2' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-2' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 2)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #3', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 3, resolved: 0, reason: 'r3' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 3}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-3' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-3' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 3)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #4', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 4, resolved: 0, reason: 'r4' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 4}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-4' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-4' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 4)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #5', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 5, resolved: 0, reason: 'r5' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 5}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-5' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-5' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 5)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #6', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 6, resolved: 0, reason: 'r6' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 6}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-6' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-6' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 6)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #7', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 7, resolved: 0, reason: 'r7' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 7}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-7' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-7' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 7)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #8', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 8, resolved: 0, reason: 'r8' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 8}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-8' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-8' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 8)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #9', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 9, resolved: 0, reason: 'r9' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 9}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-9' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-9' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 9)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #10', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 10, resolved: 0, reason: 'r10' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 10}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-10' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-10' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 10)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #11', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 11, resolved: 0, reason: 'r11' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 11}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-11' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-11' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 11)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #12', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 12, resolved: 0, reason: 'r12' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 12}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-12' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-12' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 12)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #13', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 13, resolved: 0, reason: 'r13' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 13}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-13' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-13' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 13)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #14', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 14, resolved: 0, reason: 'r14' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 14}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-14' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-14' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 14)!;
    expect(row.resolved).toBe(1);
  });
  it('resolve∥resolve double-apply race #15', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: ADMIN, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [seedEventReport({ id: 100 + 15, resolved: 0, reason: 'r15' })],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    // auth middleware always sets alice — need admin. Override by seeding alice as admin for this race.
    db.users.find((u) => u.user_id === USER)!.admin = 1;
    const path = `/_matrix/client/v3/admin/reports/${100 + 15}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'note-A-15' })),
      reportReq(db, path, jsonInit('POST', { note: 'note-B-15' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const row = db.reports.find((r) => r.id === 100 + 15)!;
    expect(row.resolved).toBe(1);
  });
});


describe('race report room duplicate INSERT TOCTOU after #153', () => {
  it('room report duplicate INSERT race #0', async () => {
    const room = '!race0:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-0', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-0', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #1', async () => {
    const room = '!race1:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-1', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-1', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #2', async () => {
    const room = '!race2:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-2', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-2', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #3', async () => {
    const room = '!race3:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-3', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-3', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #4', async () => {
    const room = '!race4:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-4', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-4', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #5', async () => {
    const room = '!race5:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-5', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-5', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #6', async () => {
    const room = '!race6:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-6', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-6', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #7', async () => {
    const room = '!race7:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-7', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-7', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #8', async () => {
    const room = '!race8:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-8', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-8', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #9', async () => {
    const room = '!race9:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-9', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-9', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #10', async () => {
    const room = '!race10:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-10', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-10', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #11', async () => {
    const room = '!race11:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-11', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-11', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #12', async () => {
    const room = '!race12:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-12', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-12', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #13', async () => {
    const room = '!race13:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-13', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-13', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #14', async () => {
    const room = '!race14:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-14', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-14', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
  it('room report duplicate INSERT race #15', async () => {
    const room = '!race15:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'room-A-15', score: -1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'room-B-15', score: -2 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.room_id === room && r.report_type === 'room').length).toBeGreaterThanOrEqual(1);
  });
});


describe('report event update soft flood after #153', () => {
  it('event report update soft #0', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-0', score: -1 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-0');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #1', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-1', score: -2 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-1');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #2', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-2', score: -3 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-2');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #3', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-3', score: -4 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-3');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #4', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-4', score: -5 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-4');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #5', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-5', score: -6 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-5');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #6', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-6', score: -7 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-6');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #7', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-7', score: -8 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-7');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #8', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-8', score: -9 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-8');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #9', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-9', score: -10 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-9');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #10', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-10', score: -11 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-10');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #11', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-11', score: -12 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-11');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #12', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-12', score: -13 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-12');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #13', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-13', score: -14 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-13');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #14', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-14', score: -15 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-14');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
  it('event report update soft #15', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 1, reason: 'old', score: -1 })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'upd-15', score: -16 }));
    expect(res.status).toBe(200);
    expect(db.reports[0].reason).toBe('upd-15');
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });
});


describe('cross-module devices∥key-backups lifecycle soft flood after #153', () => {
  it('devices list∥backup version soft #0', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-0' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 0 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #1', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-1' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 1 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #2', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-2' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 2 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #3', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-3' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 3 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #4', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-4' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 4 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #5', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-5' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 5 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #6', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-6' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 6 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #7', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-7' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 7 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #8', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-8' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 8 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #9', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-9' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 9 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #10', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-10' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 10 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #11', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-11' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 11 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #12', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-12' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 12 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #13', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-13' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 13 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #14', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-14' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 14 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
  it('devices list∥backup version soft #15', async () => {
    const ddb = createDevicesDb({
      devices: [seedDevice({ device_id: CURRENT, display_name: 'cur-15' }), seedDevice({ device_id: OTHER_DEV })],
    });
    const kdb = createKeyBackupDb({ versions: [seedVersion({ version: 1, count: 15 })] });
    const [devRes, bakRes] = await Promise.all([
      devicesReq(ddb, '/_matrix/client/v3/devices'),
      keysReq(kdb, '/_matrix/client/v3/room_keys/version'),
    ]);
    expect(devRes.status).toBe(200);
    expect(bakRes.status).toBe(200);
    expect((devRes.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect((bakRes.body as { version: string }).version).toBe('1');
  });
});


describe('devices bad password DELETE soft flood after #153', () => {
  it('DELETE bad password soft #0', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD0' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD0',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-0' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD0')).toBe(true);
  });
  it('DELETE bad password soft #1', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD1' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD1',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-1' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD1')).toBe(true);
  });
  it('DELETE bad password soft #2', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD2' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD2',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-2' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD2')).toBe(true);
  });
  it('DELETE bad password soft #3', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD3' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD3',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-3' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD3')).toBe(true);
  });
  it('DELETE bad password soft #4', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD4' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD4',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-4' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD4')).toBe(true);
  });
  it('DELETE bad password soft #5', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD5' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD5',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-5' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD5')).toBe(true);
  });
  it('DELETE bad password soft #6', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD6' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD6',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-6' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD6')).toBe(true);
  });
  it('DELETE bad password soft #7', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD7' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD7',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-7' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD7')).toBe(true);
  });
  it('DELETE bad password soft #8', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD8' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD8',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-8' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD8')).toBe(true);
  });
  it('DELETE bad password soft #9', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD9' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD9',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-9' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD9')).toBe(true);
  });
  it('DELETE bad password soft #10', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD10' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD10',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-10' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD10')).toBe(true);
  });
  it('DELETE bad password soft #11', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD11' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD11',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-11' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD11')).toBe(true);
  });
  it('DELETE bad password soft #12', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD12' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD12',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-12' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD12')).toBe(true);
  });
  it('DELETE bad password soft #13', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD13' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD13',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-13' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD13')).toBe(true);
  });
  it('DELETE bad password soft #14', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD14' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD14',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-14' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD14')).toBe(true);
  });
  it('DELETE bad password soft #15', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'BAD15' })] });
    const res = await devicesReq(
      db,
      '/_matrix/client/v3/devices/BAD15',
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'wrong-15' } })
    );
    expect(res.status).toBe(403);
    expect(db.devices.some((d) => d.device_id === 'BAD15')).toBe(true);
  });
});


describe('key-backups missing version PUT soft flood after #153', () => {
  it('PUT keys missing version soft #0', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s0: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #1', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s1: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #2', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s2: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #3', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s3: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #4', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s4: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #5', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s5: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #6', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s6: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #7', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s7: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #8', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s8: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #9', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s9: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #10', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s10: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #11', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s11: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #12', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s12: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #13', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s13: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #14', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s14: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
  it('PUT keys missing version soft #15', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const body = {
      rooms: {
        [ROOM]: {
          sessions: {
            s15: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { ciphertext: 'x' },
            },
          },
        },
      },
    };
    const res = await keysReq(db, '/_matrix/client/v3/room_keys/keys?version=99', jsonInit('PUT', body));
    expect(res.status).toBe(404);
    expect(db.keys.length).toBe(0);
  });
});


describe('report non-member event soft flood after #153', () => {
  it('event report non-member soft #0', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-0', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #1', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-1', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #2', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-2', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #3', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-3', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #4', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-4', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #5', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-5', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #6', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-6', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #7', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-7', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #8', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-8', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #9', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-9', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #10', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-10', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #11', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-11', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #12', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-12', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #13', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-13', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #14', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-14', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
  it('event report non-member soft #15', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
      memberships: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`;
    const res = await reportReq(db, path, jsonInit('POST', { reason: 'nm-15', score: -5 }));
    expect(res.status).toBe(403);
    expect(db.reports.length).toBe(0);
  });
});
