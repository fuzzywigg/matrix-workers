// Account Data API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#client-config
//
// Account data is arbitrary JSON that clients can store per-user or per-room.
// Common uses:
// - m.direct: Direct message room mappings
// - m.ignored_user_list: Blocked users
// - m.fully_read: Read marker position
// - im.vector.setting.*: Element-specific settings
// - m.secret_storage.*: Secret storage keys
//
// IMPORTANT: E2EE-related account data uses Durable Objects for strong consistency.
// This is critical during initial SSSS setup where client writes and immediately
// reads via sliding sync.

import { Hono } from 'hono';
import type { AppEnv, Env } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';

const app = new Hono<AppEnv>();

// Helper to get the UserKeys Durable Object stub for a user
function getUserKeysDO(env: Env, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

// Get E2EE account data from Durable Object (strongly consistent)
export async function getE2EEAccountDataFromDO(env: Env, userId: string, eventType?: string): Promise<any> {
  const stub = getUserKeysDO(env, userId);
  const url = eventType
    ? `http://internal/account-data/get?event_type=${encodeURIComponent(eventType)}`
    : 'http://internal/account-data/get';
  const response = await stub.fetch(new Request(url));

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    console.error('[account-data] DO get failed:', response.status, errorText, 'eventType:', eventType);
    throw new Error(`DO get failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Store E2EE account data in Durable Object (strongly consistent)
async function putE2EEAccountDataToDO(env: Env, userId: string, eventType: string, content: any): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(new Request('http://internal/account-data/put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: eventType, content }),
  }));

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    console.error('[account-data] DO put failed:', response.status, errorText, 'eventType:', eventType);
    throw new Error(`DO put failed: ${response.status} - ${errorText}`);
  }
}

// ============================================
// Helper Functions
// ============================================

async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  await db.prepare(`
    UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?
  `).bind(streamName).run();

  const result = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = ?
  `).bind(streamName).first<{ position: number }>();

  return result?.position || 1;
}

async function recordAccountDataChange(
  db: D1Database,
  userId: string,
  roomId: string,
  eventType: string
): Promise<void> {
  const streamPosition = await getNextStreamPosition(db, 'account_data');

  await db.prepare(`
    INSERT INTO account_data_changes (user_id, room_id, event_type, stream_position)
    VALUES (?, ?, ?, ?)
  `).bind(userId, roomId, eventType, streamPosition).run();
}

// ============================================
// Global Account Data
// ============================================

// Helper to check if event type should use KV for faster access
function isKVAccountData(eventType: string): boolean {
  return eventType.startsWith('m.secret_storage') ||
         eventType.startsWith('m.cross_signing') ||
         eventType === 'm.megolm_backup.v1';
}

// GET /_matrix/client/v3/user/:userId/account_data/:type
app.get('/_matrix/client/v3/user/:userId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only access their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    }, 403);
  }

  // For E2EE types, read from Durable Object (strongly consistent)
  if (isKVAccountData(eventType)) {
    // Try DO first (strongly consistent)
    try {
      const doData = await getE2EEAccountDataFromDO(c.env, targetUserId, eventType);
      if (doData !== null && doData !== undefined) {
        console.log('[account_data] Retrieved from DO:', eventType);
        return c.json(doData);
      }
    } catch (error) {
      console.error('[account_data] DO unavailable, trying fallbacks:', error);
    }

    // Fallback 1: KV (backup storage)
    try {
      const kvData = await c.env.ACCOUNT_DATA.get(`global:${targetUserId}:${eventType}`);
      if (kvData) {
        console.log('[account_data] Retrieved from KV:', eventType);
        return c.json(JSON.parse(kvData));
      }
    } catch (err) {
      console.error('[account_data] KV fallback failed:', err);
    }
  }

  // Fallback 2: D1
  const data = await db.prepare(`
    SELECT content FROM account_data
    WHERE user_id = ? AND event_type = ? AND room_id = ''
  `).bind(targetUserId, eventType).first<{ content: string }>();

  if (!data) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Account data not found',
    }, 404);
  }

  try {
    return c.json(JSON.parse(data.content));
  } catch {
    return c.json({});
  }
});

// PUT /_matrix/client/v3/user/:userId/account_data/:type
app.put('/_matrix/client/v3/user/:userId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only modify their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    }, 403);
  }

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Debug logging for ALL account_data PUT requests
  const contentStr = JSON.stringify(content);
  console.log('[account_data] PUT', eventType, 'for user:', targetUserId, 'content length:', contentStr.length);

  // Extra detailed logging for secret storage related events
  if (eventType.startsWith('m.secret_storage') || eventType.startsWith('m.cross_signing') || eventType.startsWith('m.megolm')) {
    console.log('[account_data] E2EE content:', contentStr);
  }

  // Log SSSS content for debugging but ALWAYS store it
  // Per Matrix spec MSC-1946, m.secret_storage.default_key SHOULD have a "key" property
  // but the server should NOT validate/reject - that causes client-side issues where
  // Element X thinks SSSS setup failed when it actually just got silently rejected
  if (eventType === 'm.secret_storage.default_key') {
    if (!content || typeof content !== 'object' || !content.key || typeof content.key !== 'string') {
      console.warn('[account_data] WARNING: m.secret_storage.default_key has unusual content:', contentStr);
      // Still store it - the client may be doing partial setup or recovery
    } else {
      console.log('[account_data] Valid m.secret_storage.default_key with key:', content.key);
    }
  }

  // Log m.secret_storage.key.* but ALWAYS store it
  if (eventType.startsWith('m.secret_storage.key.')) {
    if (!content || typeof content !== 'object' || !content.algorithm || typeof content.algorithm !== 'string') {
      console.warn('[account_data] WARNING:', eventType, 'has unusual content:', contentStr);
      // Still store it - the client may be doing partial setup
    } else {
      console.log('[account_data] Valid', eventType, 'with algorithm:', content.algorithm);
    }
  }

  // For E2EE types, write to Durable Object FIRST (strongly consistent)
  // This is critical for SSSS setup where client writes then immediately reads via sync
  if (isKVAccountData(eventType)) {
    try {
      await putE2EEAccountDataToDO(c.env, targetUserId, eventType, content);
      console.log('[account_data] Stored in Durable Object:', eventType);
    } catch (error) {
      console.error('[account_data] Failed to store in DO:', error);
      return c.json({
        errcode: 'M_UNKNOWN',
        error: 'Failed to store E2EE data',
      }, 503);
    }

    // Also write to KV as backup/cache
    await c.env.ACCOUNT_DATA.put(
      `global:${targetUserId}:${eventType}`,
      JSON.stringify(content)
    );
  }

  // Optional optimistic concurrency: if the client supplies If-Match with
  // an integer, refuse the write when the stored version differs (issue
  // 009 #5). When omitted, behavior is identical to the previous
  // last-write-wins upsert so existing clients are unaffected.
  const ifMatch = c.req.header('If-Match');
  const expectedVersionRaw = ifMatch ? parseInt(ifMatch, 10) : NaN;
  const useVersionCheck = !isNaN(expectedVersionRaw);

  // Idempotent upsert with monotonic version bump. INSERT OR REPLACE would
  // discard the version, so we use ON CONFLICT ... DO UPDATE.
  let updated: { version: number } | null;
  if (useVersionCheck) {
    updated = await db.prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content, version)
      VALUES (?, '', ?, ?, 1)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        version = account_data.version + 1
      WHERE account_data.version = ?
      RETURNING version
    `).bind(targetUserId, eventType, JSON.stringify(content), expectedVersionRaw)
      .first<{ version: number }>();

    if (!updated) {
      return c.json({
        errcode: 'M_CONFLICT',
        error: 'Account data version mismatch; re-fetch and retry',
      }, 409);
    }
  } else {
    updated = await db.prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content, version)
      VALUES (?, '', ?, ?, 1)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        version = account_data.version + 1
      RETURNING version
    `).bind(targetUserId, eventType, JSON.stringify(content))
      .first<{ version: number }>();
  }

  // Record change for sync
  await recordAccountDataChange(db, targetUserId, '', eventType);

  return c.json({ version: updated?.version ?? 1 });
});

// ============================================
// Room Account Data
// ============================================

// GET /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type
app.get('/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only access their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    }, 403);
  }

  // Verify user is in the room
  const membership = await db.prepare(`
    SELECT membership FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `).bind(roomId, targetUserId).first<{ membership: string }>();

  if (!membership || membership.membership !== 'join') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User not in room',
    }, 403);
  }

  const data = await db.prepare(`
    SELECT content FROM account_data
    WHERE user_id = ? AND room_id = ? AND event_type = ?
  `).bind(targetUserId, roomId, eventType).first<{ content: string }>();

  if (!data) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Account data not found',
    }, 404);
  }

  try {
    return c.json(JSON.parse(data.content));
  } catch {
    return c.json({});
  }
});

// PUT /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type
app.put('/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only modify their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    }, 403);
  }

  // Verify user is in the room
  const membership = await db.prepare(`
    SELECT membership FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `).bind(roomId, targetUserId).first<{ membership: string }>();

  if (!membership || membership.membership !== 'join') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User not in room',
    }, 403);
  }

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Optional optimistic concurrency via If-Match (see global PUT above).
  const ifMatch = c.req.header('If-Match');
  const expectedVersionRaw = ifMatch ? parseInt(ifMatch, 10) : NaN;
  const useVersionCheck = !isNaN(expectedVersionRaw);

  let updated: { version: number } | null;
  if (useVersionCheck) {
    updated = await db.prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content, version)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        version = account_data.version + 1
      WHERE account_data.version = ?
      RETURNING version
    `).bind(targetUserId, roomId, eventType, JSON.stringify(content), expectedVersionRaw)
      .first<{ version: number }>();

    if (!updated) {
      return c.json({
        errcode: 'M_CONFLICT',
        error: 'Account data version mismatch; re-fetch and retry',
      }, 409);
    }
  } else {
    updated = await db.prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content, version)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        version = account_data.version + 1
      RETURNING version
    `).bind(targetUserId, roomId, eventType, JSON.stringify(content))
      .first<{ version: number }>();
  }

  // Record change for sync
  await recordAccountDataChange(db, targetUserId, roomId, eventType);

  return c.json({ version: updated?.version ?? 1 });
});

// ============================================
// Batch Account Data (for sync)
// ============================================

export async function getGlobalAccountData(
  db: D1Database,
  userId: string,
  since?: number
): Promise<{ type: string; content: any }[]> {
  let query: string;
  const params: any[] = [userId];

  if (since !== undefined) {
    // Get only changed account data since the given position
    query = `
      SELECT ad.event_type, ad.content
      FROM account_data ad
      INNER JOIN account_data_changes adc ON
        ad.user_id = adc.user_id AND
        ad.event_type = adc.event_type AND
        ad.room_id = adc.room_id
      WHERE ad.user_id = ? AND ad.room_id = '' AND adc.stream_position > ?
      GROUP BY ad.event_type
    `;
    params.push(since);
  } else {
    // Get all account data
    query = `
      SELECT event_type, content FROM account_data
      WHERE user_id = ? AND room_id = ''
    `;
  }

  const results = await db.prepare(query).bind(...params).all<{
    event_type: string;
    content: string;
  }>();

  return results.results.map(row => ({
    type: row.event_type,
    content: JSON.parse(row.content || '{}'),
  }));
}

export async function getRoomAccountData(
  db: D1Database,
  userId: string,
  roomId: string,
  since?: number
): Promise<{ type: string; content: any }[]> {
  let query: string;
  const params: any[] = [userId, roomId];

  if (since !== undefined) {
    query = `
      SELECT ad.event_type, ad.content
      FROM account_data ad
      INNER JOIN account_data_changes adc ON
        ad.user_id = adc.user_id AND
        ad.event_type = adc.event_type AND
        ad.room_id = adc.room_id
      WHERE ad.user_id = ? AND ad.room_id = ? AND adc.stream_position > ?
      GROUP BY ad.event_type
    `;
    params.push(since);
  } else {
    query = `
      SELECT event_type, content FROM account_data
      WHERE user_id = ? AND room_id = ?
    `;
  }

  const results = await db.prepare(query).bind(...params).all<{
    event_type: string;
    content: string;
  }>();

  return results.results.map(row => ({
    type: row.event_type,
    content: JSON.parse(row.content || '{}'),
  }));
}

export async function getAllRoomAccountData(
  db: D1Database,
  userId: string,
  roomIds: string[],
  since?: number
): Promise<Record<string, { type: string; content: any }[]>> {
  if (roomIds.length === 0) return {};

  const placeholders = roomIds.map(() => '?').join(',');
  const params: any[] = [userId, ...roomIds];

  let query: string;

  if (since !== undefined) {
    query = `
      SELECT ad.room_id, ad.event_type, ad.content
      FROM account_data ad
      INNER JOIN account_data_changes adc ON
        ad.user_id = adc.user_id AND
        ad.event_type = adc.event_type AND
        ad.room_id = adc.room_id
      WHERE ad.user_id = ? AND ad.room_id IN (${placeholders}) AND adc.stream_position > ?
      GROUP BY ad.room_id, ad.event_type
    `;
    params.push(since);
  } else {
    query = `
      SELECT room_id, event_type, content FROM account_data
      WHERE user_id = ? AND room_id IN (${placeholders})
    `;
  }

  const results = await db.prepare(query).bind(...params).all<{
    room_id: string;
    event_type: string;
    content: string;
  }>();

  const byRoom: Record<string, { type: string; content: any }[]> = {};

  for (const row of results.results) {
    if (!byRoom[row.room_id]) {
      byRoom[row.room_id] = [];
    }
    byRoom[row.room_id].push({
      type: row.event_type,
      content: JSON.parse(row.content || '{}'),
    });
  }

  return byRoom;
}

// ============================================
// Get current stream position
// ============================================

export async function getAccountDataStreamPosition(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = 'account_data'
  `).first<{ position: number }>();

  return result?.position || 0;
}

export default app;
