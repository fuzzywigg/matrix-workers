// Key Backups API - E2E Encryption Key Backup/Recovery
// Implements: https://spec.matrix.org/v1.12/client-server-api/#server-side-key-backups
//
// This allows users to back up their megolm session keys to the server,
// encrypted with a recovery key, so they can recover message history
// on new devices.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';

const app = new Hono<AppEnv>();

// ============================================
// Types
// ============================================

export interface BackupAlgorithmData {
  public_key: string;
  signatures?: Record<string, Record<string, string>>;
}

interface CreateBackupRequest {
  algorithm: string;
  auth_data: BackupAlgorithmData;
}

// BackupVersionResponse matches the spec response format (used by endpoint response)
export type BackupVersionResponse = {
  algorithm: string;
  auth_data: BackupAlgorithmData;
  count: number;
  etag: string;
  version: string;
};

export interface KeyBackupData {
  first_message_index: number;
  forwarded_count: number;
  is_verified: boolean;
  session_data: Record<string, any>;
}

export interface RoomKeyBackup {
  sessions: Record<string, KeyBackupData>;
}

interface KeysBackupRequest {
  rooms: Record<string, RoomKeyBackup>;
}

/** Spec + MSC3270 algorithms accepted by POST /room_keys/version. */
export const VALID_BACKUP_ALGORITHMS = [
  'm.megolm_backup.v1.curve25519-aes-sha2',
  'org.matrix.msc3270.v1.aes-hmac-sha2',
] as const;

export type ValidBackupAlgorithm = (typeof VALID_BACKUP_ALGORITHMS)[number];

export interface KeyBackupVersionRow {
  version: number | string;
  algorithm: string;
  auth_data: string;
  count: number;
  etag: string;
}

export interface KeyBackupKeyRow {
  room_id?: string;
  session_id: string;
  first_message_index: number;
  forwarded_count: number;
  is_verified: number;
  session_data: string;
}

// ============================================
// Helper Functions (exported for unit tests)
// ============================================

export function isValidBackupAlgorithm(algorithm: string): boolean {
  return (VALID_BACKUP_ALGORITHMS as readonly string[]).includes(algorithm);
}

export function generateEtag(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

/** Format a key_backup_versions row into the Matrix CS API response shape. */
export function formatBackupVersionResponse(backup: KeyBackupVersionRow): BackupVersionResponse {
  return {
    algorithm: backup.algorithm,
    auth_data: JSON.parse(backup.auth_data) as BackupAlgorithmData,
    count: backup.count,
    etag: backup.etag,
    version: String(backup.version),
  };
}

/** Map a key_backup_keys row into KeyBackupData (is_verified is stored as 0/1). */
export function mapKeyRowToSession(key: KeyBackupKeyRow): KeyBackupData {
  return {
    first_message_index: key.first_message_index,
    forwarded_count: key.forwarded_count,
    is_verified: key.is_verified === 1,
    session_data: JSON.parse(key.session_data),
  };
}

/** Group key rows by room_id into the GET /room_keys/keys rooms payload. */
export function groupBackupKeysByRoom(
  keys: Array<KeyBackupKeyRow & { room_id: string }>
): Record<string, RoomKeyBackup> {
  const rooms: Record<string, RoomKeyBackup> = {};
  for (const key of keys) {
    if (!rooms[key.room_id]) {
      rooms[key.room_id] = { sessions: {} };
    }
    rooms[key.room_id].sessions[key.session_id] = mapKeyRowToSession(key);
  }
  return rooms;
}

/** Convert boolean is_verified from the client into the D1 INTEGER flag. */
export function verifiedFlag(isVerified: boolean | undefined | null): number {
  return isVerified ? 1 : 0;
}

/** Build bind args for upserting a session key row. */
export function sessionUpsertValues(
  userId: string,
  version: string,
  roomId: string,
  sessionId: string,
  session: KeyBackupData
): [string, string, string, string, number, number, number, string] {
  return [
    userId,
    version,
    roomId,
    sessionId,
    session.first_message_index,
    session.forwarded_count,
    verifiedFlag(session.is_verified),
    JSON.stringify(session.session_data),
  ];
}

// ============================================
// Backup Version Management
// ============================================

// POST /room_keys/version - Create a new backup version
app.post('/_matrix/client/v3/room_keys/version', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  let body: CreateBackupRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!body.algorithm || !body.auth_data) {
    return Errors.missingParam('algorithm and auth_data required').toResponse();
  }

  // Validate algorithm
  if (!isValidBackupAlgorithm(body.algorithm)) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: `Invalid algorithm. Must be one of: ${VALID_BACKUP_ALGORITHMS.join(', ')}`,
    }, 400);
  }

  const etag = generateEtag();

  const result = await db.prepare(`
    INSERT INTO key_backup_versions (user_id, algorithm, auth_data, etag, count)
    VALUES (?, ?, ?, ?, 0)
  `).bind(
    userId,
    body.algorithm,
    JSON.stringify(body.auth_data),
    etag
  ).run();

  const version = result.meta.last_row_id;

  return c.json({ version: String(version) });
});

// GET /room_keys/version - Get current backup version
app.get('/_matrix/client/v3/room_keys/version', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const backup = await db.prepare(`
    SELECT version, algorithm, auth_data, count, etag
    FROM key_backup_versions
    WHERE user_id = ? AND deleted = 0
    ORDER BY version DESC
    LIMIT 1
  `).bind(userId).first<{
    version: number;
    algorithm: string;
    auth_data: string;
    count: number;
    etag: string;
  }>();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'No backup found',
    }, 404);
  }

  return c.json(formatBackupVersionResponse(backup));
});

// GET /room_keys/version/:version - Get specific backup version
app.get('/_matrix/client/v3/room_keys/version/:version', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const version = c.req.param('version');
  const db = c.env.DB;

  const backup = await db.prepare(`
    SELECT version, algorithm, auth_data, count, etag
    FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first<{
    version: number;
    algorithm: string;
    auth_data: string;
    count: number;
    etag: string;
  }>();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  return c.json(formatBackupVersionResponse(backup));
});

// PUT /room_keys/version/:version - Update backup version auth_data
app.put('/_matrix/client/v3/room_keys/version/:version', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const version = c.req.param('version');
  const db = c.env.DB;

  let body: { algorithm?: string; auth_data?: BackupAlgorithmData };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check backup exists
  const backup = await db.prepare(`
    SELECT version FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Update auth_data if provided
  if (body.auth_data) {
    await db.prepare(`
      UPDATE key_backup_versions
      SET auth_data = ?
      WHERE user_id = ? AND version = ?
    `).bind(JSON.stringify(body.auth_data), userId, version).run();
  }

  return c.json({});
});

// DELETE /room_keys/version/:version - Delete backup version
app.delete('/_matrix/client/v3/room_keys/version/:version', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const version = c.req.param('version');
  const db = c.env.DB;

  // Soft delete the backup version
  const result = await db.prepare(`
    UPDATE key_backup_versions
    SET deleted = 1
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).run();

  if (result.meta.changes === 0) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Also delete all keys for this version
  await db.prepare(`
    DELETE FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).run();

  return c.json({});
});

// ============================================
// Key Upload/Download
// ============================================

// PUT /room_keys/keys - Upload all keys
app.put('/_matrix/client/v3/room_keys/keys', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  let body: KeysBackupRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check backup version exists
  const backup = await db.prepare(`
    SELECT version, etag FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first<{ version: number; etag: string }>();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  let count = 0;

  // Process each room
  for (const [roomId, roomBackup] of Object.entries(body.rooms || {})) {
    for (const [sessionId, sessionData] of Object.entries(roomBackup.sessions || {})) {
      // Upsert the key
      await db.prepare(`
        INSERT INTO key_backup_keys (
          user_id, version, room_id, session_id,
          first_message_index, forwarded_count, is_verified, session_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, version, room_id, session_id) DO UPDATE SET
          first_message_index = excluded.first_message_index,
          forwarded_count = excluded.forwarded_count,
          is_verified = excluded.is_verified,
          session_data = excluded.session_data
      `).bind(...sessionUpsertValues(userId, version, roomId, sessionId, sessionData)).run();
      count++;
    }
  }

  // Update backup count and etag
  const newEtag = generateEtag();
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).first<{ count: number }>();

  await db.prepare(`
    UPDATE key_backup_versions
    SET count = ?, etag = ?
    WHERE user_id = ? AND version = ?
  `).bind(totalCount?.count || 0, newEtag, userId, version).run();

  return c.json({
    count: totalCount?.count || 0,
    etag: newEtag,
  });
});

// PUT /room_keys/keys/:roomId - Upload keys for a room
app.put('/_matrix/client/v3/room_keys/keys/:roomId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  let body: RoomKeyBackup;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check backup version exists
  const backup = await db.prepare(`
    SELECT version FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Process sessions
  for (const [sessionId, sessionData] of Object.entries(body.sessions || {})) {
    await db.prepare(`
      INSERT INTO key_backup_keys (
        user_id, version, room_id, session_id,
        first_message_index, forwarded_count, is_verified, session_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, version, room_id, session_id) DO UPDATE SET
        first_message_index = excluded.first_message_index,
        forwarded_count = excluded.forwarded_count,
        is_verified = excluded.is_verified,
        session_data = excluded.session_data
    `).bind(...sessionUpsertValues(userId, version, roomId, sessionId, sessionData)).run();
  }

  // Update count and etag
  const newEtag = generateEtag();
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).first<{ count: number }>();

  await db.prepare(`
    UPDATE key_backup_versions
    SET count = ?, etag = ?
    WHERE user_id = ? AND version = ?
  `).bind(totalCount?.count || 0, newEtag, userId, version).run();

  return c.json({
    count: totalCount?.count || 0,
    etag: newEtag,
  });
});

// PUT /room_keys/keys/:roomId/:sessionId - Upload single session key
app.put('/_matrix/client/v3/room_keys/keys/:roomId/:sessionId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const sessionId = c.req.param('sessionId');
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  let body: KeyBackupData;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check backup version exists
  const backup = await db.prepare(`
    SELECT version FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Upsert the key
  await db.prepare(`
    INSERT INTO key_backup_keys (
      user_id, version, room_id, session_id,
      first_message_index, forwarded_count, is_verified, session_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, version, room_id, session_id) DO UPDATE SET
      first_message_index = excluded.first_message_index,
      forwarded_count = excluded.forwarded_count,
      is_verified = excluded.is_verified,
      session_data = excluded.session_data
  `).bind(...sessionUpsertValues(userId, version, roomId, sessionId, body)).run();

  // Update count and etag
  const newEtag = generateEtag();
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).first<{ count: number }>();

  await db.prepare(`
    UPDATE key_backup_versions
    SET count = ?, etag = ?
    WHERE user_id = ? AND version = ?
  `).bind(totalCount?.count || 0, newEtag, userId, version).run();

  return c.json({
    count: totalCount?.count || 0,
    etag: newEtag,
  });
});

// GET /room_keys/keys - Download all keys
app.get('/_matrix/client/v3/room_keys/keys', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  // Check backup version exists
  const backup = await db.prepare(`
    SELECT version FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Get all keys
  const keys = await db.prepare(`
    SELECT room_id, session_id, first_message_index, forwarded_count, is_verified, session_data
    FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).all<{
    room_id: string;
    session_id: string;
    first_message_index: number;
    forwarded_count: number;
    is_verified: number;
    session_data: string;
  }>();

  return c.json({ rooms: groupBackupKeysByRoom(keys.results) });
});

// GET /room_keys/keys/:roomId - Download keys for a room
app.get('/_matrix/client/v3/room_keys/keys/:roomId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  // Check backup version exists
  const backup = await db.prepare(`
    SELECT version FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Get keys for room
  const keys = await db.prepare(`
    SELECT session_id, first_message_index, forwarded_count, is_verified, session_data
    FROM key_backup_keys
    WHERE user_id = ? AND version = ? AND room_id = ?
  `).bind(userId, version, roomId).all<{
    session_id: string;
    first_message_index: number;
    forwarded_count: number;
    is_verified: number;
    session_data: string;
  }>();

  const sessions: Record<string, KeyBackupData> = {};
  for (const key of keys.results) {
    sessions[key.session_id] = mapKeyRowToSession(key);
  }

  return c.json({ sessions });
});

// GET /room_keys/keys/:roomId/:sessionId - Download single session key
app.get('/_matrix/client/v3/room_keys/keys/:roomId/:sessionId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const sessionId = c.req.param('sessionId');
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  // Check backup version exists
  const backup = await db.prepare(`
    SELECT version FROM key_backup_versions
    WHERE user_id = ? AND version = ? AND deleted = 0
  `).bind(userId, version).first();

  if (!backup) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    }, 404);
  }

  // Get specific key
  const key = await db.prepare(`
    SELECT first_message_index, forwarded_count, is_verified, session_data
    FROM key_backup_keys
    WHERE user_id = ? AND version = ? AND room_id = ? AND session_id = ?
  `).bind(userId, version, roomId, sessionId).first<{
    first_message_index: number;
    forwarded_count: number;
    is_verified: number;
    session_data: string;
  }>();

  if (!key) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Key not found',
    }, 404);
  }

  return c.json(mapKeyRowToSession(key));
});

// DELETE /room_keys/keys - Delete all keys
app.delete('/_matrix/client/v3/room_keys/keys', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  // Delete all keys for this version
  await db.prepare(`
    DELETE FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).run();

  // Update count and etag
  const newEtag = generateEtag();
  await db.prepare(`
    UPDATE key_backup_versions
    SET count = 0, etag = ?
    WHERE user_id = ? AND version = ?
  `).bind(newEtag, userId, version).run();

  return c.json({
    count: 0,
    etag: newEtag,
  });
});

// DELETE /room_keys/keys/:roomId - Delete room keys
app.delete('/_matrix/client/v3/room_keys/keys/:roomId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  // Delete room keys
  await db.prepare(`
    DELETE FROM key_backup_keys
    WHERE user_id = ? AND version = ? AND room_id = ?
  `).bind(userId, version, roomId).run();

  // Update count and etag
  const newEtag = generateEtag();
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).first<{ count: number }>();

  await db.prepare(`
    UPDATE key_backup_versions
    SET count = ?, etag = ?
    WHERE user_id = ? AND version = ?
  `).bind(totalCount?.count || 0, newEtag, userId, version).run();

  return c.json({
    count: totalCount?.count || 0,
    etag: newEtag,
  });
});

// DELETE /room_keys/keys/:roomId/:sessionId - Delete single session key
app.delete('/_matrix/client/v3/room_keys/keys/:roomId/:sessionId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const sessionId = c.req.param('sessionId');
  const version = c.req.query('version');
  const db = c.env.DB;

  if (!version) {
    return Errors.missingParam('version').toResponse();
  }

  // Delete specific key
  await db.prepare(`
    DELETE FROM key_backup_keys
    WHERE user_id = ? AND version = ? AND room_id = ? AND session_id = ?
  `).bind(userId, version, roomId, sessionId).run();

  // Update count and etag
  const newEtag = generateEtag();
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM key_backup_keys
    WHERE user_id = ? AND version = ?
  `).bind(userId, version).first<{ count: number }>();

  await db.prepare(`
    UPDATE key_backup_versions
    SET count = ?, etag = ?
    WHERE user_id = ? AND version = ?
  `).bind(totalCount?.count || 0, newEtag, userId, version).run();

  return c.json({
    count: totalCount?.count || 0,
    etag: newEtag,
  });
});

export default app;
