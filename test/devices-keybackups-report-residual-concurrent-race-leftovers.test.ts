/**
 * TOKENMAXX HEAVY leftovers after #214 — residual *devices + key-backups + report*
 * concurrent-race / TOCTOU slices not covered by #174 (devices-keybackups-report)
 * or #200 (report + server-notices; server-notices left alone).
 *
 * Distinct from #174: PUT∥PUT display_name, DELETE∥DELETE, PUT∥DELETE,
 * overlapping delete_devices, GET-list∥DELETE, POST version mint, same-session
 * PUT overwrite, PUT-keys∥DELETE-version, double soft-delete, DELETE∥PUT session,
 * event/room duplicate INSERT, admin resolve double-apply.
 * Distinct from #200: user-report duplicate INSERT, report UPDATE LWW, event
 * POST∥resolve, admin list∥get∥resolve, cross-type, score clamp, leave membership
 * (already leave), pagination, non-admin, server-notices.
 *
 * Residual focus:
 *   devices — GET :deviceId∥DELETE; GET-list∥PUT; PUT omit-name∥DELETE;
 *     delete_devices∥PUT / ∥UIA-DELETE; sibling isolation; token-run GET mid-delete;
 *     missing 404; empty bulk; bind order.
 *   key-backups — GET-current∥POST/DELETE; PUT auth_data∥DELETE / ∥PUT LWW;
 *     distinct-session COUNT lost-update; bulk∥room PUT; DELETE all∥room∥session;
 *     GET∥PUT keys; cross-version / MSC3270∥megolm; empty PUT etag; missing version.
 *   report — join→ban after membership SELECT still INSERT; event vanish after
 *     event SELECT still INSERT / before SELECT 404; room/user vanish after lookup
 *     still INSERT; invite/knock/ban forbid; re-report does not un-resolve;
 *     admin resolved true∥false; missing GET/resolve 404; NaN score.
 *
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
const DEVICE = 'PHONE';
const OTHER_DEV = 'LAPTOP';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const EVENT = '$evt:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const ALG_MEGOLM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const ALG_MSC = 'org.matrix.msc3270.v1.aes-hmac-sha2';
const AUTH_DATA = {
  public_key: 'curve25519pubkey',
  signatures: { [USER]: { 'ed25519:DEVICE': 'sig' } },
};
const PASS = 's3cret';
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;
const SESSION = 'sessionABC';
const SESSION_B = 'sessionDEF';

const DEVICES = '/_matrix/client/v3/devices';
const DELETE_DEVICES = '/_matrix/client/v3/delete_devices';
const KEYS = '/_matrix/client/v3/room_keys/keys';
const VERSION = '/_matrix/client/v3/room_keys/version';

type SqlCall = { sql: string; args: unknown[] };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};
type TokenRow = { user_id: string; device_id: string };
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

async function withBarrier(
  barrier: SqlBarrier | undefined,
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

function envFor(db: unknown): Env {
  return { DB: db, SERVER_NAME: 'example.com' } as unknown as Env;
}

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': contentType, ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function authInit(method: string): RequestInit {
  return { method, headers: AUTH };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status);
}

function errcode(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'errcode' in body) {
    return (body as { errcode: string }).errcode;
  }
  return undefined;
}

function sessionPayload(cipher: string) {
  return {
    first_message_index: 0,
    forwarded_count: 0,
    is_verified: true,
    session_data: { ciphertext: cipher },
  };
}

function bulkKeys(cipher: string, sessionId = SESSION, roomId = ROOM) {
  return { rooms: { [roomId]: { sessions: { [sessionId]: sessionPayload(cipher) } } } };
}

function pwAuth(devicesList: string[]) {
  return { devices: devicesList, auth: { type: 'm.login.password', password: PASS } };
}

function seedDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    device_id: overrides.device_id ?? DEVICE,
    user_id: overrides.user_id ?? USER,
    display_name: overrides.display_name ?? null,
    last_seen_ts: overrides.last_seen_ts ?? NOW,
    last_seen_ip: overrides.last_seen_ip ?? '127.0.0.1',
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
    resolved_by: overrides.resolved_by ?? null,
    resolved_at: overrides.resolved_at ?? null,
    resolution_note: overrides.resolution_note ?? null,
    report_type: overrides.report_type ?? 'event',
    reported_user_id: overrides.reported_user_id ?? BOB,
  };
}

function createDevicesDb(
  opts: {
    devices?: DeviceRow[];
    tokens?: TokenRow[];
    keys?: TokenRow[];
    passwordHash?: string | null;
    missingUser?: boolean;
    selectBarrier?: SqlBarrier;
    allBarrier?: SqlBarrier;
    runBarrier?: SqlBarrier;
    mutateAfterSelects?: { after: number; mutate: (db: DevicesDb) => void };
    mutateAfterRuns?: { after: number; mutate: (db: DevicesDb) => void };
    failRunAfter?: number;
  } = {}
) {
  const deviceRows = opts.devices ?? [];
  const tokens = opts.tokens ?? deviceRows.map((d) => ({ user_id: d.user_id, device_id: d.device_id }));
  const keys = opts.keys ?? deviceRows.map((d) => ({ user_id: d.user_id, device_id: d.device_id }));
  const passwordHash = opts.passwordHash === undefined ? 'mockok:s3cret' : opts.passwordHash;
  const missingUser = opts.missingUser ?? false;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  let allBarrier = opts.allBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const allWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let selectCount = 0;
  let runCount = 0;

  const db = {
    devices: deviceRows,
    tokens,
    keys,
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
              events.push(`first:${sql.slice(0, 40)}`);
              selectCount += 1;
              await withBarrier(selectBarrier, selectWaiters, () => {
                selectBarrier = undefined;
              }, sql, args);
              if (opts.mutateAfterSelects && selectCount === opts.mutateAfterSelects.after) {
                opts.mutateAfterSelects.mutate(db);
                events.push('mutate:after-select');
              }
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
                const row = deviceRows.find((d) => d.user_id === userId && d.device_id === deviceId);
                if (!row) return null as T;
                return {
                  device_id: row.device_id,
                  display_name: row.display_name,
                  last_seen_ts: row.last_seen_ts,
                  last_seen_ip: row.last_seen_ip,
                } as T;
              }
              if (sql.includes('SELECT device_id FROM devices') && sql.includes('device_id = ?')) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find((d) => d.user_id === userId && d.device_id === deviceId);
                return (row ? { device_id: row.device_id } : null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              await withBarrier(allBarrier, allWaiters, () => {
                allBarrier = undefined;
              }, sql, args);
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
              await withBarrier(runBarrier, runWaiters, () => {
                runBarrier = undefined;
              }, sql, args);
              runCount += 1;
              if (opts.failRunAfter !== undefined && runCount > opts.failRunAfter) {
                throw new Error('d1-run-fail');
              }
              if (opts.mutateAfterRuns && runCount === opts.mutateAfterRuns.after) {
                opts.mutateAfterRuns.mutate(db);
                events.push('mutate:after-run');
              }
              if (sql.includes('UPDATE devices SET display_name')) {
                updates.push({ sql, args });
                events.push('run:update-display');
                const [displayName, userId, deviceId] = args as [string, string, string];
                const row = deviceRows.find((d) => d.user_id === userId && d.device_id === deviceId);
                if (row) row.display_name = displayName;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                events.push('run:delete-tokens');
                const [userId, deviceId] = args as string[];
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId && tokens[i].device_id === deviceId) {
                    tokens.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM device_keys')) {
                deletes.push({ sql, args });
                events.push('run:delete-keys');
                const [userId, deviceId] = args as string[];
                for (let i = keys.length - 1; i >= 0; i--) {
                  if (keys[i].user_id === userId && keys[i].device_id === deviceId) {
                    keys.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM devices')) {
                deletes.push({ sql, args });
                events.push('run:delete-device');
                const [userId, deviceId] = args as string[];
                const before = deviceRows.length;
                for (let i = deviceRows.length - 1; i >= 0; i--) {
                  if (deviceRows[i].user_id === userId && deviceRows[i].device_id === deviceId) {
                    deviceRows.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: before - deviceRows.length, last_row_id: 0 } };
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
    selectBarrier?: SqlBarrier;
    allBarrier?: SqlBarrier;
    runBarrier?: SqlBarrier;
    mutateAfterSelects?: { after: number; mutate: (db: KeyBackupDb) => void };
    failRunAfter?: number;
  } = {}
) {
  const versions = opts.versions ?? [];
  const keys = opts.keys ?? [];
  let nextVersionId = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  let allBarrier = opts.allBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const allWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let selectCount = 0;
  let runCount = 0;

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
              selectCount += 1;
              await withBarrier(selectBarrier, selectWaiters, () => {
                selectBarrier = undefined;
              }, sql, args);
              if (opts.mutateAfterSelects && selectCount === opts.mutateAfterSelects.after) {
                opts.mutateAfterSelects.mutate(db);
                events.push('mutate:after-select');
              }
              if (sql.includes('SELECT COUNT(*) as count FROM key_backup_keys')) {
                if (opts.nullCount) return null as T;
                const userId = args[0] as string;
                const version = String(args[1]);
                const count = keys.filter((k) => k.user_id === userId && k.version === version).length;
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
                if (sql.includes('etag')) return { version: hit.version, etag: hit.etag } as T;
                return { version: hit.version } as T;
              }
              return null;
            },
            async all<T>() {
              await withBarrier(allBarrier, allWaiters, () => {
                allBarrier = undefined;
              }, sql, args);
              if (sql.includes('FROM key_backup_keys') && sql.includes('SELECT room_id, session_id')) {
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
                    (k) => k.user_id === userId && k.version === version && k.room_id === roomId
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
              await withBarrier(runBarrier, runWaiters, () => {
                runBarrier = undefined;
              }, sql, args);
              runCount += 1;
              if (opts.failRunAfter !== undefined && runCount > opts.failRunAfter) {
                throw new Error('d1-run-fail');
              }
              if (sql.includes('INSERT INTO key_backup_versions')) {
                inserts.push({ sql, args });
                events.push('run:insert-version');
                const [userId, algorithm, auth_data, etag] = args as [string, string, string, string];
                const version = nextVersionId++;
                versions.push({ version, user_id: userId, algorithm, auth_data, etag, count: 0, deleted: 0 });
                return { success: true, meta: { changes: 1, last_row_id: version } };
              }
              if (sql.includes('UPDATE key_backup_versions') && sql.includes('SET deleted = 1')) {
                updates.push({ sql, args });
                events.push('run:soft-delete-version');
                const [userId, version] = args as [string, string];
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === Number(version) && v.deleted === 0
                );
                if (!hit) return { success: true, meta: { changes: 0, last_row_id: 0 } };
                hit.deleted = 1;
                return { success: true, meta: { changes: 1, last_row_id: hit.version } };
              }
              if (sql.includes('UPDATE key_backup_versions') && sql.includes('SET auth_data = ?')) {
                updates.push({ sql, args });
                events.push('run:update-auth');
                const [auth_data, userId, version] = args as [string, string, string];
                const hit = versions.find((v) => v.user_id === userId && v.version === Number(version));
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
                const [count, etag, userId, version] = args as [number, string, string, string];
                const hit = versions.find((v) => v.user_id === userId && v.version === Number(version));
                if (hit) {
                  hit.count = count;
                  hit.etag = etag;
                }
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE key_backup_versions') && sql.includes('SET count = 0, etag = ?')) {
                updates.push({ sql, args });
                events.push('run:zero-count');
                const [etag, userId, version] = args as [string, string, string];
                const hit = versions.find((v) => v.user_id === userId && v.version === Number(version));
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
                ] = args as [string, string, string, string, number, number, number, string];
                const id = keyId(userId, String(version), roomId, sessionId);
                const existing = keys.findIndex(
                  (k) => keyId(k.user_id, k.version, k.room_id, k.session_id) === id
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
                if (existing >= 0) keys[existing] = row;
                else keys.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM key_backup_keys') && sql.includes('session_id = ?')) {
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
                return { success: true, meta: { changes: before - keys.length, last_row_id: 0 } };
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
                  if (k.user_id === userId && k.version === String(version) && k.room_id === roomId) {
                    keys.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: before - keys.length, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM key_backup_keys')) {
                deletes.push({ sql, args });
                events.push('run:delete-all-keys');
                const [userId, version] = args as string[];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  const k = keys[i];
                  if (k.user_id === userId && k.version === String(version)) keys.splice(i, 1);
                }
                return { success: true, meta: { changes: before - keys.length, last_row_id: 0 } };
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
    selectBarrier?: SqlBarrier;
    allBarrier?: SqlBarrier;
    runBarrier?: SqlBarrier;
    mutateAfterSelects?: { after: number; mutate: (db: ReportDb) => void };
    failRunAfter?: number;
  } = {}
) {
  const users = opts.users ?? [
    { user_id: USER, admin: 0 },
    { user_id: BOB, admin: 0 },
  ];
  const rooms = opts.rooms ?? [ROOM, ROOM2];
  const events = opts.events ?? [];
  const memberships = opts.memberships ?? [];
  const reports = opts.reports ?? [];
  let nextId = reports.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const eventsLog: string[] = [];
  let selectBarrier = opts.selectBarrier;
  let allBarrier = opts.allBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const allWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let selectCount = 0;
  let runCount = 0;

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
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              eventsLog.push(`first:${sql.slice(0, 48)}`);
              selectCount += 1;
              await withBarrier(selectBarrier, selectWaiters, () => {
                selectBarrier = undefined;
              }, sql, args);
              if (opts.mutateAfterSelects && selectCount === opts.mutateAfterSelects.after) {
                opts.mutateAfterSelects.mutate(db);
                eventsLog.push('mutate:after-select');
              }
              if (sql.includes('SELECT membership FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
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
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 180)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              await withBarrier(allBarrier, allWaiters, () => {
                allBarrier = undefined;
              }, sql, args);
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
            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              await withBarrier(runBarrier, runWaiters, () => {
                runBarrier = undefined;
              }, sql, args);
              runCount += 1;
              if (opts.failRunAfter !== undefined && runCount > opts.failRunAfter) {
                throw new Error('d1-run-fail');
              }
              if (
                sql.includes('UPDATE content_reports SET reason = ?, score = ?, created_at = ?') &&
                sql.includes('event_id = ?') &&
                !sql.includes('IS NULL')
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-event-report');
                const [reason, score, createdAt, reporter, roomId, eventId] = args as [
                  string, number, number, string, string, string,
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
                  string, number, number, string, string,
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
                const [reason, createdAt, reporter, reported] = args as [string, number, string, string];
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
              if (sql.includes('UPDATE content_reports') && sql.includes('SET resolved = 1')) {
                updates.push({ sql, args });
                eventsLog.push('run:resolve');
                const [resolvedBy, resolvedAt, note, id] = args as [
                  string, number, string | null, number,
                ];
                const row = reports.find((r) => r.id === id);
                if (!row) return { success: true, meta: { changes: 0, last_row_id: 0 } };
                row.resolved = 1;
                row.resolved_by = resolvedBy;
                row.resolved_at = resolvedAt;
                row.resolution_note = note;
                return { success: true, meta: { changes: 1, last_row_id: row.id } };
              }
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes('(reporter_user_id, room_id, event_id, reason, score, created_at)') &&
                !sql.includes('report_type')
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-event-report');
                const [reporter, roomId, eventId, reason, score, createdAt] = args as [
                  string, string, string, string, number, number,
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
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes("VALUES (?, ?, NULL, ?, ?, ?, 'room')")
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-room-report');
                const [reporter, roomId, reason, score, createdAt] = args as [
                  string, string, string, number, number,
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
              if (sql.includes('INSERT INTO content_reports') && sql.includes('reported_user_id')) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-user-report');
                const [reporter, reason, createdAt, reportedUser] = args as [
                  string, string, number, string,
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

beforeEach(() => {
  vi.mocked(verifyPassword).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// devices — GET :deviceId ∥ DELETE (list∥DELETE already in #174)
// ---------------------------------------------------------------------------

describe('race devices GET :deviceId∥DELETE residual after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`GET :deviceId∥DELETE barrier race #${i}`, async () => {
      const id = `GDEL${i}`;
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: id, display_name: `n-${i}` })],
        selectBarrier: {
          match: (sql) => sql.includes('FROM devices') && sql.includes('device_id = ?'),
          count: 2,
        },
      });
      const path = `${DEVICES}/${id}`;
      const [got, del] = await Promise.all([
        devicesReq(db, path, authInit('GET')),
        devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
      ]);
      expect([200, 404]).toContain(got.status);
      expect(del.status).toBe(200);
      expect(db.devices.find((d) => d.device_id === id)).toBeUndefined();
    });
  }

  it('GET after DELETE 404s', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const path = `${DEVICES}/${DEVICE}`;
    const del = await devicesReq(
      db,
      path,
      jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })
    );
    const got = await devicesReq(db, path, authInit('GET'));
    expect(del.status).toBe(200);
    expect(got.status).toBe(404);
    expect(errcode(got.body)).toBe('M_NOT_FOUND');
  });
});

describe('race devices GET list∥PUT display_name residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`GET list∥PUT display_name race #${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ display_name: `old-${i}` })],
      });
      const [list, put] = await Promise.all([
        devicesReq(db, DEVICES, authInit('GET')),
        devicesReq(db, `${DEVICES}/${DEVICE}`, jsonInit('PUT', { display_name: `new-${i}` })),
      ]);
      expect(list.status).toBe(200);
      expect(put.status).toBe(200);
      const names = (list.body as { devices: Array<{ display_name?: string }> }).devices.map(
        (d) => d.display_name
      );
      expect(names.length).toBe(1);
      expect([`old-${i}`, `new-${i}`, undefined]).toContain(names[0]);
      expect(db.devices[0].display_name).toBe(`new-${i}`);
    });
  }
});

describe('race devices PUT omit-name∥DELETE residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`PUT {} omit display_name∥DELETE #${i}`, async () => {
      const id = `OMIT${i}`;
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: id, display_name: `keep-${i}` })],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT device_id FROM devices'),
          count: 2,
        },
      });
      const path = `${DEVICES}/${id}`;
      const [put, del] = await Promise.all([
        devicesReq(db, path, jsonInit('PUT', {})),
        devicesReq(db, path, jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })),
      ]);
      expect(put.status).toBe(200);
      expect(del.status).toBe(200);
      expect(db.updates.filter((u) => u.sql.includes('display_name'))).toHaveLength(0);
      expect(db.devices.find((d) => d.device_id === id)).toBeUndefined();
    });
  }
});

describe('race devices delete_devices∥PUT residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`delete_devices∥PUT same device #${i}`, async () => {
      const id = `BULKPUT${i}`;
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: id, display_name: `pre-${i}` })],
      });
      const [bulk, put] = await Promise.all([
        devicesReq(db, DELETE_DEVICES, jsonInit('POST', pwAuth([id]))),
        devicesReq(db, `${DEVICES}/${id}`, jsonInit('PUT', { display_name: `post-${i}` })),
      ]);
      expect(bulk.status).toBe(200);
      expect([200, 404]).toContain(put.status);
      expect(db.devices.find((d) => d.device_id === id)).toBeUndefined();
    });
  }
});

describe('race devices delete_devices∥UIA DELETE residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`delete_devices∥DELETE UIA same device #${i}`, async () => {
      const id = `BULKDEL${i}`;
      const db = createDevicesDb({ devices: [seedDevice({ device_id: id })] });
      const [bulk, del] = await Promise.all([
        devicesReq(db, DELETE_DEVICES, jsonInit('POST', pwAuth([id]))),
        devicesReq(
          db,
          `${DEVICES}/${id}`,
          jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })
        ),
      ]);
      expect(bulk.status).toBe(200);
      expect([200, 404]).toContain(del.status);
      expect(db.devices.find((d) => d.device_id === id)).toBeUndefined();
    });
  }
});

describe('race devices sibling isolation DELETE∥PUT residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`DELETE PHONE∥PUT LAPTOP isolation #${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: DEVICE, display_name: 'phone' }),
          seedDevice({ device_id: OTHER_DEV, display_name: `lap-old-${i}` }),
        ],
      });
      const [del, put] = await Promise.all([
        devicesReq(
          db,
          `${DEVICES}/${DEVICE}`,
          jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })
        ),
        devicesReq(db, `${DEVICES}/${OTHER_DEV}`, jsonInit('PUT', { display_name: `lap-new-${i}` })),
      ]);
      expect(del.status).toBe(200);
      expect(put.status).toBe(200);
      expect(db.devices.map((d) => d.device_id)).toEqual([OTHER_DEV]);
      expect(db.devices[0].display_name).toBe(`lap-new-${i}`);
      expect(db.tokens.every((t) => t.device_id !== DEVICE)).toBe(true);
      expect(db.tokens.some((t) => t.device_id === OTHER_DEV)).toBe(true);
      expect(db.keys.every((k) => k.device_id !== DEVICE)).toBe(true);
      expect(db.keys.some((k) => k.device_id === OTHER_DEV)).toBe(true);
    });
  }
});

describe('race devices GET :deviceId∥PUT coherency residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`GET :deviceId∥PUT display_name #${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ display_name: `g-old-${i}` })],
      });
      const [got, put] = await Promise.all([
        devicesReq(db, `${DEVICES}/${DEVICE}`, authInit('GET')),
        devicesReq(db, `${DEVICES}/${DEVICE}`, jsonInit('PUT', { display_name: `g-new-${i}` })),
      ]);
      expect(put.status).toBe(200);
      expect(got.status).toBe(200);
      const name = (got.body as { display_name?: string }).display_name;
      expect([`g-old-${i}`, `g-new-${i}`]).toContain(name);
      expect(db.devices[0].display_name).toBe(`g-new-${i}`);
    });
  }
});

describe('race devices missing 404 concurrent residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`PUT missing device 404 parallel #${i}`, async () => {
      const db = createDevicesDb({ devices: [] });
      const results = await Promise.all([
        devicesReq(db, `${DEVICES}/GONE${i}`, jsonInit('PUT', { display_name: 'x' })),
        devicesReq(db, `${DEVICES}/GONE${i}`, jsonInit('PUT', { display_name: 'y' })),
      ]);
      expect(statusesOf(results)).toEqual([404, 404]);
      expect(results.every((r) => errcode(r.body) === 'M_NOT_FOUND')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`DELETE missing device 404 parallel #${i}`, async () => {
      const db = createDevicesDb({ devices: [] });
      const auth = { auth: { type: 'm.login.password', password: PASS } };
      const results = await Promise.all([
        devicesReq(db, `${DEVICES}/MISS${i}`, jsonInit('DELETE', auth)),
        devicesReq(db, `${DEVICES}/MISS${i}`, jsonInit('DELETE', auth)),
      ]);
      expect(statusesOf(results)).toEqual([404, 404]);
    });
  }
});

describe('race devices token-run GET mid-delete residual after #214', () => {
  for (let i = 0; i < 4; i++) {
    it(`GET during access_tokens DELETE still 200 #${i}`, async () => {
      const id = `MID${i}`;
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: id, display_name: `mid-${i}` })],
        runBarrier: {
          match: (sql) => sql.includes('DELETE FROM access_tokens'),
          count: 1,
        },
      });
      const delP = devicesReq(
        db,
        `${DEVICES}/${id}`,
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })
      );
      await Promise.resolve();
      const got = await devicesReq(db, `${DEVICES}/${id}`, authInit('GET'));
      const del = await delP;
      expect(del.status).toBe(200);
      expect([200, 404]).toContain(got.status);
      expect(db.devices.find((d) => d.device_id === id)).toBeUndefined();
    });
  }
});

describe('race devices empty bulk / bind / soft residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`delete_devices empty list leaves rows #${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `KEEP${i}` })],
      });
      const results = await Promise.all([
        devicesReq(db, DELETE_DEVICES, jsonInit('POST', pwAuth([]))),
        devicesReq(db, DEVICES, authInit('GET')),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(db.devices).toHaveLength(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`delete_devices missing devices param 400 #${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const results = await Promise.all([
        devicesReq(db, DELETE_DEVICES, jsonInit('POST', { auth: { type: 'm.login.password', password: PASS } })),
        devicesReq(db, DELETE_DEVICES, jsonInit('POST', { auth: { type: 'm.login.password', password: PASS } })),
      ]);
      expect(statusesOf(results)).toEqual([400, 400]);
      expect(results.every((r) => errcode(r.body) === 'M_MISSING_PARAM')).toBe(true);
      expect(db.devices).toHaveLength(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`PUT bad JSON parallel #${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const results = await Promise.all([
        devicesReq(db, `${DEVICES}/${DEVICE}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        }),
        devicesReq(db, `${DEVICES}/${DEVICE}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        }),
      ]);
      expect(statusesOf(results)).toEqual([400, 400]);
      expect(results.every((r) => errcode(r.body) === 'M_BAD_JSON')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`PUT charset utf-8 display_name #${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const res = await devicesReq(
        db,
        `${DEVICES}/${DEVICE}`,
        jsonInit('PUT', { display_name: `utf-${i}` }, 'application/json; charset=utf-8')
      );
      expect(res.status).toBe(200);
      expect(db.devices[0].display_name).toBe(`utf-${i}`);
    });
  }

  it('DELETE bind order tokens→keys→devices under parallel sibling', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: DEVICE }), seedDevice({ device_id: OTHER_DEV })],
    });
    await Promise.all([
      devicesReq(
        db,
        `${DEVICES}/${DEVICE}`,
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })
      ),
      devicesReq(db, `${DEVICES}/${OTHER_DEV}`, authInit('GET')),
    ]);
    const phoneDeletes = db.deletes.filter((d) => d.args[1] === DEVICE);
    expect(phoneDeletes.map((d) => d.sql)).toEqual([
      expect.stringContaining('DELETE FROM access_tokens'),
      expect.stringContaining('DELETE FROM device_keys'),
      expect.stringContaining('DELETE FROM devices'),
    ]);
    expect(phoneDeletes.every((d) => d.args[0] === USER && d.args[1] === DEVICE)).toBe(true);
  });

  it('delete_devices unknown ids still 200 and does not revive', async () => {
    const db = createDevicesDb({ devices: [seedDevice()] });
    const results = await Promise.all([
      devicesReq(db, DELETE_DEVICES, jsonInit('POST', pwAuth(['NOPE', 'ALSO']))),
      devicesReq(db, DEVICES, authInit('GET')),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(db.devices.map((d) => d.device_id)).toEqual([DEVICE]);
  });
});

// ---------------------------------------------------------------------------
// key-backups residual
// ---------------------------------------------------------------------------

describe('race key-backups GET current∥POST mint residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`GET current∥POST new version #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1, etag: `e${i}` })],
      });
      const [got, posted] = await Promise.all([
        keysReq(db, VERSION, authInit('GET')),
        keysReq(db, VERSION, jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })),
      ]);
      expect(posted.status).toBe(200);
      expect([200, 404]).toContain(got.status);
      if (got.status === 200) {
        expect(['1', '2']).toContain((got.body as { version: string }).version);
      }
      expect(db.versions.filter((v) => v.deleted === 0)).toHaveLength(2);
      const current = await keysReq(db, VERSION, authInit('GET'));
      expect((current.body as { version: string }).version).toBe('2');
    });
  }
});

describe('race key-backups GET current∥DELETE current residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`GET current∥DELETE version #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 3, etag: `cur${i}` })],
        keys: [seedKey({ version: '3', session_id: `s${i}` })],
      });
      const [got, del] = await Promise.all([
        keysReq(db, VERSION, authInit('GET')),
        keysReq(db, `${VERSION}/3`, authInit('DELETE')),
      ]);
      expect(del.status).toBe(200);
      expect([200, 404]).toContain(got.status);
      expect(db.versions.find((v) => v.version === 3)?.deleted).toBe(1);
      expect(db.keys.filter((k) => k.version === '3')).toHaveLength(0);
    });
  }
});

describe('race key-backups PUT auth_data∥DELETE residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`PUT auth_data SELECT→UPDATE∥DELETE #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1 })],
        selectBarrier: {
          match: (sql) =>
            sql.includes('FROM key_backup_versions') &&
            sql.includes('version = ?') &&
            sql.includes('deleted = 0') &&
            !sql.includes('COUNT'),
          count: 1,
        },
      });
      const auth_data = { ...AUTH_DATA, public_key: `pk-${i}` };
      const [put, del] = await Promise.all([
        keysReq(db, `${VERSION}/1`, jsonInit('PUT', { algorithm: ALG_MEGOLM, auth_data })),
        keysReq(db, `${VERSION}/1`, authInit('DELETE')),
      ]);
      expect([200, 404]).toContain(put.status);
      expect([200, 404]).toContain(del.status);
      expect(put.status === 200 || del.status === 200).toBe(true);
      if (del.status === 200) {
        expect(db.versions[0].deleted).toBe(1);
      }
    });
  }
});

describe('race key-backups PUT auth_data LWW residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`PUT∥PUT auth_data SELECT barrier LWW #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 4 })],
        selectBarrier: {
          match: (sql) =>
            sql.includes('SELECT version FROM key_backup_versions') && sql.includes('deleted = 0'),
          count: 2,
        },
      });
      const [a, b] = await Promise.all([
        keysReq(db, `${VERSION}/4`, jsonInit('PUT', { auth_data: { ...AUTH_DATA, public_key: `A-${i}` } })),
        keysReq(db, `${VERSION}/4`, jsonInit('PUT', { auth_data: { ...AUTH_DATA, public_key: `B-${i}` } })),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(db.updates.filter((u) => u.sql.includes('auth_data'))).toHaveLength(2);
      expect([`A-${i}`, `B-${i}`]).toContain(JSON.parse(db.versions[0].auth_data).public_key);
    });
  }
});

describe('race key-backups distinct-session COUNT lost-update residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`PUT session A∥PUT session B COUNT TOCTOU #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1, count: 0 })],
        keys: [],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT COUNT(*) as count FROM key_backup_keys'),
          count: 2,
        },
      });
      const [a, b] = await Promise.all([
        keysReq(
          db,
          `${KEYS}/${ROOM_ENC}/${SESSION}?version=1`,
          jsonInit('PUT', sessionPayload(`A-${i}`))
        ),
        keysReq(
          db,
          `${KEYS}/${ROOM_ENC}/${SESSION_B}?version=1`,
          jsonInit('PUT', sessionPayload(`B-${i}`))
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(db.keys).toHaveLength(2);
      // Last COUNT may have run after 1 or 2 upserts — stored count is stale or exact.
      expect([1, 2]).toContain(db.versions[0].count);
      expect(new Set(db.keys.map((k) => k.session_id))).toEqual(new Set([SESSION, SESSION_B]));
    });
  }
});

describe('race key-backups bulk∥room PUT + DELETE scopes residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`PUT bulk∥PUT room keys union #${i}`, async () => {
      const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
      const [bulk, room] = await Promise.all([
        keysReq(db, `${KEYS}?version=1`, jsonInit('PUT', bulkKeys(`bulk-${i}`))),
        keysReq(
          db,
          `${KEYS}/${ROOM_ENC}?version=1`,
          jsonInit('PUT', { sessions: { [SESSION_B]: sessionPayload(`room-${i}`) } })
        ),
      ]);
      expect(bulk.status).toBe(200);
      expect(room.status).toBe(200);
      expect(db.keys.map((k) => k.session_id).sort()).toEqual([SESSION_B, SESSION].sort());
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`DELETE all keys∥DELETE room keys #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1, count: 2 })],
        keys: [
          seedKey({ session_id: SESSION, room_id: ROOM }),
          seedKey({ session_id: SESSION_B, room_id: ROOM2 }),
        ],
      });
      const [all, room] = await Promise.all([
        keysReq(db, `${KEYS}?version=1`, authInit('DELETE')),
        keysReq(db, `${KEYS}/${ROOM_ENC}?version=1`, authInit('DELETE')),
      ]);
      expect(all.status).toBe(200);
      expect(room.status).toBe(200);
      expect(db.keys).toHaveLength(0);
      expect(db.versions[0].count).toBe(0);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`DELETE session∥DELETE room overlapping #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1, count: 2 })],
        keys: [
          seedKey({ session_id: SESSION }),
          seedKey({ session_id: SESSION_B }),
        ],
      });
      const [sess, room] = await Promise.all([
        keysReq(db, `${KEYS}/${ROOM_ENC}/${SESSION}?version=1`, authInit('DELETE')),
        keysReq(db, `${KEYS}/${ROOM_ENC}?version=1`, authInit('DELETE')),
      ]);
      expect(sess.status).toBe(200);
      expect(room.status).toBe(200);
      expect(db.keys.filter((k) => k.room_id === ROOM)).toHaveLength(0);
    });
  }
});

describe('race key-backups GET∥PUT keys + version GET∥DELETE residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`GET all keys∥PUT bulk mid-flight #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1 })],
        keys: [seedKey({ session_data: JSON.stringify({ ciphertext: `seed-${i}` }) })],
      });
      const [got, put] = await Promise.all([
        keysReq(db, `${KEYS}?version=1`, authInit('GET')),
        keysReq(db, `${KEYS}?version=1`, jsonInit('PUT', bulkKeys(`put-${i}`, SESSION_B))),
      ]);
      expect(got.status).toBe(200);
      expect(put.status).toBe(200);
      const rooms = (got.body as { rooms: Record<string, { sessions: Record<string, unknown> }> }).rooms;
      const sessionIds = Object.keys(rooms[ROOM]?.sessions ?? {});
      expect(sessionIds.includes(SESSION) || sessionIds.includes(SESSION_B) || sessionIds.length === 1).toBe(
        true
      );
      expect(db.keys.some((k) => k.session_id === SESSION_B)).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`GET version/:v∥DELETE #${i}`, async () => {
      const db = createKeyBackupDb({ versions: [seedVersion({ version: 7, etag: `v${i}` })] });
      const [got, del] = await Promise.all([
        keysReq(db, `${VERSION}/7`, authInit('GET')),
        keysReq(db, `${VERSION}/7`, authInit('DELETE')),
      ]);
      expect(del.status).toBe(200);
      expect([200, 404]).toContain(got.status);
      if (got.status === 200) expect((got.body as { version: string }).version).toBe('7');
    });
  }
});

describe('race key-backups cross-version / algorithm / empty PUT residual after #214', () => {
  for (let i = 0; i < 4; i++) {
    it(`PUT keys v1∥v2 isolation #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1 }), seedVersion({ version: 2 })],
      });
      const [a, b] = await Promise.all([
        keysReq(db, `${KEYS}?version=1`, jsonInit('PUT', bulkKeys(`v1-${i}`))),
        keysReq(db, `${KEYS}?version=2`, jsonInit('PUT', bulkKeys(`v2-${i}`, SESSION_B))),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(db.keys.filter((k) => k.version === '1')).toHaveLength(1);
      expect(db.keys.filter((k) => k.version === '2')).toHaveLength(1);
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`POST MSC3270∥megolm distinct versions #${i}`, async () => {
      const db = createKeyBackupDb({ versions: [] });
      const [m, s] = await Promise.all([
        keysReq(db, VERSION, jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })),
        keysReq(db, VERSION, jsonInit('POST', { algorithm: ALG_MSC, auth_data: AUTH_DATA })),
      ]);
      expect(m.status).toBe(200);
      expect(s.status).toBe(200);
      expect(db.versions).toHaveLength(2);
      const algs = db.versions.map((v) => v.algorithm).sort();
      expect(algs).toEqual([ALG_MEGOLM, ALG_MSC].sort());
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`PUT empty rooms still rotates etag #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1, etag: `old-${i}`, count: 1 })],
        keys: [seedKey()],
      });
      const [put, got] = await Promise.all([
        keysReq(db, `${KEYS}?version=1`, jsonInit('PUT', { rooms: {} })),
        keysReq(db, `${VERSION}/1`, authInit('GET')),
      ]);
      expect(put.status).toBe(200);
      expect(got.status).toBe(200);
      expect((put.body as { count: number }).count).toBe(1);
      expect(db.versions[0].etag).not.toBe(`old-${i}`);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`GET session 404∥PUT session #${i}`, async () => {
      const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
      const path = `${KEYS}/${ROOM_ENC}/new${i}?version=1`;
      const [got, put] = await Promise.all([
        keysReq(db, path, authInit('GET')),
        keysReq(db, path, jsonInit('PUT', sessionPayload(`n-${i}`))),
      ]);
      expect([404, 200]).toContain(got.status);
      expect(put.status).toBe(200);
      expect(db.keys.some((k) => k.session_id === `new${i}`)).toBe(true);
    });
  }
});

describe('race key-backups missing version / deleted-only / isolation residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`GET/PUT/DELETE keys missing version query 400 #${i}`, async () => {
      const db = createKeyBackupDb({ versions: [seedVersion()] });
      const results = await Promise.all([
        keysReq(db, KEYS, authInit('GET')),
        keysReq(db, KEYS, jsonInit('PUT', bulkKeys('x'))),
        keysReq(db, KEYS, authInit('DELETE')),
      ]);
      expect(statusesOf(results)).toEqual([400, 400, 400]);
      expect(results.every((r) => errcode(r.body) === 'M_MISSING_PARAM')).toBe(true);
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`GET current 404 when only deleted versions #${i}`, async () => {
      const db = createKeyBackupDb({
        versions: [seedVersion({ version: 1, deleted: 1 })],
      });
      const results = await Promise.all([
        keysReq(db, VERSION, authInit('GET')),
        keysReq(db, VERSION, authInit('GET')),
      ]);
      expect(statusesOf(results)).toEqual([404, 404]);
      expect(results.every((r) => errcode(r.body) === 'M_NOT_FOUND')).toBe(true);
    });
  }

  it('GET keys 404 when version soft-deleted but key rows remain', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, deleted: 1 })],
      keys: [seedKey()],
    });
    const results = await Promise.all([
      keysReq(db, `${KEYS}?version=1`, authInit('GET')),
      keysReq(db, `${KEYS}/${ROOM_ENC}?version=1`, authInit('GET')),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
    expect(results.every((r) => errcode(r.body) === 'M_NOT_FOUND')).toBe(true);
    expect(db.keys).toHaveLength(1);
  });

  it('cross-user GET current ignores other user backup', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ user_id: BOB, version: 9 })],
    });
    const results = await Promise.all([
      keysReq(db, VERSION, authInit('GET')),
      keysReq(db, VERSION, authInit('GET')),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  it('DELETE keys on missing version still 200 count 0', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const results = await Promise.all([
      keysReq(db, `${KEYS}?version=99`, authInit('DELETE')),
      keysReq(db, `${KEYS}?version=99`, authInit('DELETE')),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { count: number }).count === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// report residual (not #174 INSERT dup / #200 UPDATE LWW / leave-already-leave)
// ---------------------------------------------------------------------------

describe('race report join→ban after membership SELECT residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`join→ban after membership SELECT still INSERT #${i}`, async () => {
      const evt = `$ban${i}:example.com`;
      const db = createReportDb({
        events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        mutateAfterSelects: {
          after: 2,
          mutate: (d) => {
            d.memberships[0].membership = 'ban';
          },
        },
      });
      const res = await reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: `ban-${i}`, score: -9 })
      );
      expect(res.status).toBe(200);
      expect(db.memberships[0].membership).toBe('ban');
      expect(db.reports.some((r) => r.event_id === evt)).toBe(true);
    });
  }
});

describe('race report event vanish TOCTOU residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`event vanish after event SELECT still INSERT #${i}`, async () => {
      const evt = `$vanish${i}:example.com`;
      const db = createReportDb({
        events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        mutateAfterSelects: {
          after: 3,
          mutate: (d) => {
            d.events.length = 0;
          },
        },
      });
      const res = await reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: `v-${i}`, score: -4 })
      );
      expect(res.status).toBe(200);
      expect(db.events).toHaveLength(0);
      expect(db.reports.some((r) => r.event_id === evt)).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`event vanish before event SELECT 404 #${i}`, async () => {
      const evt = `$gone${i}:example.com`;
      const db = createReportDb({
        events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        mutateAfterSelects: {
          after: 2,
          mutate: (d) => {
            d.events.length = 0;
          },
        },
      });
      const res = await reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: `g-${i}` })
      );
      expect(res.status).toBe(404);
      expect(errcode(res.body)).toBe('M_NOT_FOUND');
      expect(db.reports).toHaveLength(0);
    });
  }
});

describe('race report room/user vanish after lookup residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`room vanish after room SELECT still INSERT #${i}`, async () => {
      const db = createReportDb({
        rooms: [ROOM],
        mutateAfterSelects: {
          after: 2,
          mutate: (d) => {
            d.rooms.length = 0;
          },
        },
      });
      const res = await reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report`,
        jsonInit('POST', { reason: `room-v-${i}`, score: -3 })
      );
      expect(res.status).toBe(200);
      expect(db.rooms).toHaveLength(0);
      expect(db.reports.some((r) => r.report_type === 'room')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`user vanish after user SELECT still INSERT #${i}`, async () => {
      const db = createReportDb({
        users: [
          { user_id: USER, admin: 0 },
          { user_id: BOB, admin: 0 },
        ],
        mutateAfterSelects: {
          after: 2,
          mutate: (d) => {
            const idx = d.users.findIndex((u) => u.user_id === BOB);
            if (idx >= 0) d.users.splice(idx, 1);
          },
        },
      });
      const res = await reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(BOB)}/report`,
        jsonInit('POST', { reason: `user-v-${i}` })
      );
      expect(res.status).toBe(200);
      expect(db.users.find((u) => u.user_id === BOB)).toBeUndefined();
      expect(db.reports.some((r) => r.report_type === 'user' && r.reported_user_id === BOB)).toBe(true);
    });
  }
});

describe('race report invite/knock/ban forbid residual after #214', () => {
  for (const membership of ['invite', 'knock', 'ban'] as const) {
    for (let i = 0; i < 6; i++) {
      it(`${membership} membership parallel 403 #${i}`, async () => {
        const evt = `$${membership}${i}:example.com`;
        const db = createReportDb({
          events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
          memberships: [{ room_id: ROOM, user_id: USER, membership }],
          selectBarrier: {
            match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
            count: 2,
          },
        });
        const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
        const results = await Promise.all([
          reportReq(db, path, jsonInit('POST', { reason: 'no' })),
          reportReq(db, path, jsonInit('POST', { reason: 'no2' })),
        ]);
        expect(statusesOf(results)).toEqual([403, 403]);
        expect(results.every((r) => errcode(r.body) === 'M_FORBIDDEN')).toBe(true);
        expect(db.reports).toHaveLength(0);
      });
    }
  }
});

describe('race report re-report does not un-resolve residual after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`POST event on resolved report keeps resolved=1 #${i}`, async () => {
      const evt = `$res${i}:example.com`;
      const db = createReportDb({
        events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        reports: [
          seedEventReport({
            id: 50 + i,
            event_id: evt,
            resolved: 1,
            resolved_by: USER,
            reason: 'old',
            score: -10,
          }),
        ],
      });
      const results = await Promise.all([
        reportReq(
          db,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: `new-${i}`, score: -20 })
        ),
        reportReq(
          db,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: `new2-${i}`, score: -30 })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const row = db.reports.find((r) => r.event_id === evt)!;
      expect(row.resolved).toBe(1);
      expect([`new-${i}`, `new2-${i}`]).toContain(row.reason);
      expect(db.reports.filter((r) => r.event_id === evt)).toHaveLength(1);
    });
  }
});

describe('race report admin list resolved true∥false residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`admin list resolved=true∥false isolation #${i}`, async () => {
      const db = createReportDb({
        users: [{ user_id: USER, admin: 1 }, { user_id: BOB, admin: 0 }],
        events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, content: '{"m":1}' }],
        reports: [
          seedEventReport({ id: 1, resolved: 0, reason: `open-${i}` }),
          seedEventReport({ id: 2, event_id: '$b:example.com', resolved: 1, reason: `done-${i}` }),
        ],
        allBarrier: {
          match: (sql) => sql.includes('FROM content_reports cr'),
          count: 2,
        },
      });
      const [open, done] = await Promise.all([
        reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false', authInit('GET')),
        reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true', authInit('GET')),
      ]);
      expect(open.status).toBe(200);
      expect(done.status).toBe(200);
      const openIds = (open.body as { reports: Array<{ id: number }> }).reports.map((r) => r.id);
      const doneIds = (done.body as { reports: Array<{ id: number }> }).reports.map((r) => r.id);
      expect(openIds).toEqual([1]);
      expect(doneIds).toEqual([2]);
    });
  }
});

describe('race report admin missing GET/resolve 404 residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`admin GET missing parallel 404 #${i}`, async () => {
      const db = createReportDb({
        users: [{ user_id: USER, admin: 1 }],
        reports: [],
      });
      const results = await Promise.all([
        reportReq(db, '/_matrix/client/v3/admin/reports/999', authInit('GET')),
        reportReq(db, '/_matrix/client/v3/admin/reports/998', authInit('GET')),
      ]);
      expect(statusesOf(results)).toEqual([404, 404]);
      expect(results.every((r) => errcode(r.body) === 'M_NOT_FOUND')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`admin resolve missing parallel 404 #${i}`, async () => {
      const db = createReportDb({
        users: [{ user_id: USER, admin: 1 }],
        reports: [],
      });
      const results = await Promise.all([
        reportReq(db, '/_matrix/client/v3/admin/reports/404/resolve', jsonInit('POST', { note: 'n' })),
        reportReq(db, '/_matrix/client/v3/admin/reports/405/resolve', jsonInit('POST', { note: 'n' })),
      ]);
      expect(statusesOf(results)).toEqual([404, 404]);
    });
  }
});

describe('race report NaN score / empty body / isolation residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`string score defaults vs numeric concurrent #${i}`, async () => {
      const evt = `$nan${i}:example.com`;
      const db = createReportDb({
        events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        reports: [seedEventReport({ id: 80 + i, event_id: evt, score: -50, reason: 'seed' })],
      });
      const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
      const [str, num] = await Promise.all([
        reportReq(db, path, jsonInit('POST', { reason: 'str', score: '-12' })),
        reportReq(db, path, jsonInit('POST', { reason: 'num', score: -12 })),
      ]);
      expect(str.status).toBe(200);
      expect(num.status).toBe(200);
      expect(db.reports.filter((r) => r.event_id === evt)).toHaveLength(1);
      expect([-12, -100]).toContain(db.reports[0].score);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`empty body vs reason concurrent #${i}`, async () => {
      const evt = `$empty${i}:example.com`;
      const db = createReportDb({
        events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      });
      const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
      const [empty, reason] = await Promise.all([
        reportReq(db, path, jsonInit('POST', {})),
        reportReq(db, path, jsonInit('POST', { reason: `why-${i}`, score: -7 })),
      ]);
      expect(empty.status).toBe(200);
      expect(reason.status).toBe(200);
      expect(['', `why-${i}`]).toContain(db.reports[0].reason);
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`cross-room event report isolation #${i}`, async () => {
      const e1 = `$c1${i}:example.com`;
      const e2 = `$c2${i}:example.com`;
      const db = createReportDb({
        rooms: [ROOM, ROOM2],
        events: [
          { event_id: e1, room_id: ROOM, sender: BOB },
          { event_id: e2, room_id: ROOM2, sender: BOB },
        ],
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'join' },
        ],
      });
      const [a, b] = await Promise.all([
        reportReq(
          db,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
          jsonInit('POST', { reason: 'r1' })
        ),
        reportReq(
          db,
          `/_matrix/client/v3/rooms/${ROOM2_ENC}/report/${encodeURIComponent(e2)}`,
          jsonInit('POST', { reason: 'r2' })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(db.reports).toHaveLength(2);
      expect(db.reports.find((r) => r.room_id === ROOM)?.event_id).toBe(e1);
      expect(db.reports.find((r) => r.room_id === ROOM2)?.event_id).toBe(e2);
    });
  }
});

describe('race report admin GET∥re-report + bind residual after #214', () => {
  for (let i = 0; i < 4; i++) {
    it(`admin GET∥event re-report reason #${i}`, async () => {
      const db = createReportDb({
        users: [{ user_id: USER, admin: 1 }],
        events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, content: '{"ok":true}' }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        reports: [seedEventReport({ id: 7, reason: `old-${i}` })],
      });
      const [got, post] = await Promise.all([
        reportReq(db, '/_matrix/client/v3/admin/reports/7', authInit('GET')),
        reportReq(
          db,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`,
          jsonInit('POST', { reason: `fresh-${i}`, score: -1 })
        ),
      ]);
      expect(got.status).toBe(200);
      expect(post.status).toBe(200);
      const reason = (got.body as { reason: string }).reason;
      expect([`old-${i}`, `fresh-${i}`]).toContain(reason);
      expect(db.reports[0].reason).toBe(`fresh-${i}`);
    });
  }

  it('event report INSERT bind contract under parallel', async () => {
    const e1 = '$b1:example.com';
    const e2 = '$b2:example.com';
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: BOB },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'a', score: -5 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'b', score: -6 })
      ),
    ]);
    expect(db.inserts).toHaveLength(2);
    for (const ins of db.inserts) {
      expect(ins.args[0]).toBe(USER);
      expect(ins.args[1]).toBe(ROOM);
      expect([e1, e2]).toContain(ins.args[2]);
    }
  });

  for (let i = 0; i < 6; i++) {
    it(`event report method GET 404 #${i}`, async () => {
      const db = createReportDb({
        events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      });
      const results = await Promise.all([
        reportReq(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`, authInit('GET')),
        reportReq(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`, authInit('GET')),
      ]);
      expect(results.every((r) => r.status === 404)).toBe(true);
    });
  }
});

describe('cross-module devices∥key-backups∥report isolation residual after #214', () => {
  for (let i = 0; i < 6; i++) {
    it(`parallel devices PUT + keys PUT + event report #${i}`, async () => {
      const devicesDb = createDevicesDb({
        devices: [seedDevice({ display_name: `iso-${i}` })],
      });
      const keysDb = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
      const reportsDb = createReportDb({
        events: [{ event_id: EVENT, room_id: ROOM, sender: BOB }],
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      });
      const [d, k, r] = await Promise.all([
        devicesReq(devicesDb, `${DEVICES}/${DEVICE}`, jsonInit('PUT', { display_name: `iso-new-${i}` })),
        keysReq(keysDb, `${KEYS}?version=1`, jsonInit('PUT', bulkKeys(`iso-${i}`))),
        reportReq(
          reportsDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${EVENT_ENC}`,
          jsonInit('POST', { reason: `iso-${i}` })
        ),
      ]);
      expect(d.status).toBe(200);
      expect(k.status).toBe(200);
      expect(r.status).toBe(200);
      expect(devicesDb.devices[0].display_name).toBe(`iso-new-${i}`);
      expect(keysDb.keys).toHaveLength(1);
      expect(reportsDb.reports).toHaveLength(1);
      expect(keysDb.keys[0].session_id).toBe(SESSION);
    });
  }
});
