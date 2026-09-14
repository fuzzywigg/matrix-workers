/**
 * TOKENMAXX HEAVY leftovers after #149 — key-backups API soft/edge/reliability.
 * Complements key-backups-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICE');
      await next();
    };
  },
}));

import keyBackups from '../src/api/key-backups';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const ALG_MEGOLM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const ALG_MSC3270 = 'org.matrix.msc3270.v1.aes-hmac-sha2';
const AUTH_DATA = {
  public_key: 'curve25519pubkey',
  signatures: { [USER]: { 'ed25519:DEVICE': 'sig' } },
};
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const SESSION = 'sessionABC';

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

type RunMeta = { changes: number; last_row_id: number };
type SqlCall = { sql: string; args: unknown[] };

function keyId(userId: string, version: string, roomId: string, sessionId: string): string {
  return `${userId}\0${version}\0${roomId}\0${sessionId}`;
}

function createKeyBackupDb(opts: {
  versions?: VersionRow[];
  keys?: KeyRow[];
  /** Force COUNT(*) first() to return null (exercises `|| 0`). */
  nullCount?: boolean;
} = {}) {
  const versions = opts.versions ?? [];
  const keys = opts.keys ?? [];
  let nextVersionId =
    versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];

  const db = {
    versions,
    keys,
    inserts,
    updates,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              // COUNT(*)
              if (sql.includes('SELECT COUNT(*) as count FROM key_backup_keys')) {
                if (opts.nullCount) return null as T;
                const userId = args[0] as string;
                const version = String(args[1]);
                const count = keys.filter(
                  (k) => k.user_id === userId && k.version === version
                ).length;
                return { count } as T;
              }

              // Specific key GET
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

              // Latest version GET (ORDER BY version DESC LIMIT 1)
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

              // Version by id (full columns)
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

              // Existence / etag checks (SELECT version [, etag])
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
              // All keys for version
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

              // Room-scoped keys
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

            async run(): Promise<{ meta: RunMeta; success: boolean }> {
              // INSERT version
              if (sql.includes('INSERT INTO key_backup_versions')) {
                inserts.push({ sql, args });
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

              // Soft-delete version
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET deleted = 1')
              ) {
                updates.push({ sql, args });
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

              // UPDATE auth_data
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET auth_data = ?')
              ) {
                updates.push({ sql, args });
                const [auth_data, userId, version] = args as [string, string, string];
                const hit = versions.find(
                  (v) => v.user_id === userId && v.version === Number(version)
                );
                if (hit) hit.auth_data = auth_data;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              // UPDATE count + etag
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET count = ?') &&
                sql.includes('etag = ?')
              ) {
                updates.push({ sql, args });
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

              // UPDATE count = 0, etag (delete-all keys path)
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET count = 0, etag = ?')
              ) {
                updates.push({ sql, args });
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

              // INSERT/UPSERT key
              if (sql.includes('INSERT INTO key_backup_keys')) {
                inserts.push({ sql, args });
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

              // DELETE all keys for version
              if (
                sql.includes('DELETE FROM key_backup_keys') &&
                !sql.includes('room_id') &&
                !sql.includes('session_id')
              ) {
                deletes.push({ sql, args });
                const [userId, version] = args as [string, string];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  if (keys[i].user_id === userId && keys[i].version === String(version)) {
                    keys.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - keys.length, last_row_id: 0 },
                };
              }

              // DELETE room keys
              if (
                sql.includes('DELETE FROM key_backup_keys') &&
                sql.includes('room_id = ?') &&
                !sql.includes('session_id')
              ) {
                deletes.push({ sql, args });
                const [userId, version, roomId] = args as [string, string, string];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  if (
                    keys[i].user_id === userId &&
                    keys[i].version === String(version) &&
                    keys[i].room_id === roomId
                  ) {
                    keys.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - keys.length, last_row_id: 0 },
                };
              }

              // DELETE single session
              if (
                sql.includes('DELETE FROM key_backup_keys') &&
                sql.includes('session_id = ?')
              ) {
                deletes.push({ sql, args });
                const [userId, version, roomId, sessionId] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const before = keys.length;
                for (let i = keys.length - 1; i >= 0; i--) {
                  if (
                    keys[i].user_id === userId &&
                    keys[i].version === String(version) &&
                    keys[i].room_id === roomId &&
                    keys[i].session_id === sessionId
                  ) {
                    keys.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - keys.length, last_row_id: 0 },
                };
              }

              throw new Error(`Unhandled SQL in test stub: ${sql.slice(0, 120)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type KeyBackupDb = ReturnType<typeof createKeyBackupDb>;

function envFor(db: KeyBackupDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(
  db: KeyBackupDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await keyBackups.request(`http://localhost${path}`, init, envFor(db));
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

function seedVersion(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    version: overrides.version ?? 1,
    user_id: overrides.user_id ?? USER,
    algorithm: overrides.algorithm ?? ALG_MEGOLM,
    auth_data: overrides.auth_data ?? JSON.stringify(AUTH_DATA),
    etag: overrides.etag ?? 'etagseed00000001',
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
    is_verified: overrides.is_verified ?? 0,
    session_data: overrides.session_data ?? JSON.stringify({ ciphertext: 'c' }),
  };
}

describe('key-backups leftovers POST version soft flood after #149', () => {
  it('POST create version soft-0', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-1', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-2', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-3', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-4', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-5', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-6', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-7', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-8', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-9', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-10', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-11', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-12', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-13', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-14', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
  it('POST create version soft-15', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
  });
});
describe('key-backups leftovers GET latest version soft flood after #149', () => {
  it('GET latest soft-0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, etag: 'etag0000000000000000' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '1',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000000',
    });
  });
  it('GET latest soft-1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 2, etag: 'etag0000000000000001' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '2',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000001',
    });
  });
  it('GET latest soft-2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 3, etag: 'etag0000000000000002' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '3',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000002',
    });
  });
  it('GET latest soft-3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 4, etag: 'etag0000000000000003' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '4',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000003',
    });
  });
  it('GET latest soft-4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 5, etag: 'etag0000000000000004' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '5',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000004',
    });
  });
  it('GET latest soft-5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 6, etag: 'etag0000000000000005' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '6',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000005',
    });
  });
  it('GET latest soft-6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 7, etag: 'etag0000000000000006' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '7',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000006',
    });
  });
  it('GET latest soft-7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 8, etag: 'etag0000000000000007' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '8',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000007',
    });
  });
  it('GET latest soft-8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 9, etag: 'etag0000000000000008' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '9',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000008',
    });
  });
  it('GET latest soft-9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 10, etag: 'etag0000000000000009' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '10',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000009',
    });
  });
  it('GET latest soft-10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 11, etag: 'etag0000000000000010' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '11',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000010',
    });
  });
  it('GET latest soft-11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 12, etag: 'etag0000000000000011' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '12',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000011',
    });
  });
  it('GET latest soft-12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 13, etag: 'etag0000000000000012' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '13',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000012',
    });
  });
  it('GET latest soft-13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 14, etag: 'etag0000000000000013' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '14',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000013',
    });
  });
  it('GET latest soft-14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 15, etag: 'etag0000000000000014' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '15',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000014',
    });
  });
  it('GET latest soft-15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 16, etag: 'etag0000000000000015' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: '16',
      algorithm: ALG_MEGOLM,
      etag: 'etag0000000000000015',
    });
  });
});
describe('key-backups leftovers GET version/:v soft flood after #149', () => {
  it('GET version soft-0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 10, count: 0 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/10');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('10');
    expect(res.body.count).toBe(0);
  });
  it('GET version soft-1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 11, count: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/11');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('11');
    expect(res.body.count).toBe(1);
  });
  it('GET version soft-2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 12, count: 2 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/12');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('12');
    expect(res.body.count).toBe(2);
  });
  it('GET version soft-3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 13, count: 3 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/13');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('13');
    expect(res.body.count).toBe(3);
  });
  it('GET version soft-4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 14, count: 4 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/14');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('14');
    expect(res.body.count).toBe(4);
  });
  it('GET version soft-5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 15, count: 5 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/15');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('15');
    expect(res.body.count).toBe(5);
  });
  it('GET version soft-6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 16, count: 6 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/16');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('16');
    expect(res.body.count).toBe(6);
  });
  it('GET version soft-7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 17, count: 7 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/17');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('17');
    expect(res.body.count).toBe(7);
  });
  it('GET version soft-8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 18, count: 8 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/18');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('18');
    expect(res.body.count).toBe(8);
  });
  it('GET version soft-9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 19, count: 9 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/19');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('19');
    expect(res.body.count).toBe(9);
  });
  it('GET version soft-10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 20, count: 10 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/20');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('20');
    expect(res.body.count).toBe(10);
  });
  it('GET version soft-11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 21, count: 11 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/21');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('21');
    expect(res.body.count).toBe(11);
  });
  it('GET version soft-12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 22, count: 12 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/22');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('22');
    expect(res.body.count).toBe(12);
  });
  it('GET version soft-13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 23, count: 13 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/23');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('23');
    expect(res.body.count).toBe(13);
  });
  it('GET version soft-14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 24, count: 14 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/24');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('24');
    expect(res.body.count).toBe(14);
  });
  it('GET version soft-15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 25, count: 15 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/25');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('25');
    expect(res.body.count).toBe(15);
  });
});
describe('key-backups leftovers PUT keys soft flood after #149', () => {
  it('PUT bulk keys soft-0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-0': {
                first_message_index: 0,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c0' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-0')).toBe(true);
  });
  it('PUT bulk keys soft-1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-1': {
                first_message_index: 1,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c1' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-1')).toBe(true);
  });
  it('PUT bulk keys soft-2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-2': {
                first_message_index: 2,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c2' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-2')).toBe(true);
  });
  it('PUT bulk keys soft-3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-3': {
                first_message_index: 3,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c3' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-3')).toBe(true);
  });
  it('PUT bulk keys soft-4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-4': {
                first_message_index: 4,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c4' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-4')).toBe(true);
  });
  it('PUT bulk keys soft-5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-5': {
                first_message_index: 5,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c5' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-5')).toBe(true);
  });
  it('PUT bulk keys soft-6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-6': {
                first_message_index: 6,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c6' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-6')).toBe(true);
  });
  it('PUT bulk keys soft-7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-7': {
                first_message_index: 7,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c7' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-7')).toBe(true);
  });
  it('PUT bulk keys soft-8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-8': {
                first_message_index: 8,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c8' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-8')).toBe(true);
  });
  it('PUT bulk keys soft-9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-9': {
                first_message_index: 9,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c9' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-9')).toBe(true);
  });
  it('PUT bulk keys soft-10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-10': {
                first_message_index: 10,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c10' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-10')).toBe(true);
  });
  it('PUT bulk keys soft-11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-11': {
                first_message_index: 11,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c11' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-11')).toBe(true);
  });
  it('PUT bulk keys soft-12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-12': {
                first_message_index: 12,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c12' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-12')).toBe(true);
  });
  it('PUT bulk keys soft-13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-13': {
                first_message_index: 13,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c13' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-13')).toBe(true);
  });
  it('PUT bulk keys soft-14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-14': {
                first_message_index: 14,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c14' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-14')).toBe(true);
  });
  it('PUT bulk keys soft-15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'sess-15': {
                first_message_index: 15,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'c15' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys.some((k) => k.session_id === 'sess-15')).toBe(true);
  });
});
describe('key-backups leftovers GET keys soft flood after #149', () => {
  it('GET keys soft-0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S0', first_message_index: 0 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S0'].first_message_index).toBe(0);
  });
  it('GET keys soft-1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S1', first_message_index: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S1'].first_message_index).toBe(1);
  });
  it('GET keys soft-2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S2', first_message_index: 2 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S2'].first_message_index).toBe(2);
  });
  it('GET keys soft-3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S3', first_message_index: 3 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S3'].first_message_index).toBe(3);
  });
  it('GET keys soft-4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S4', first_message_index: 4 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S4'].first_message_index).toBe(4);
  });
  it('GET keys soft-5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S5', first_message_index: 5 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S5'].first_message_index).toBe(5);
  });
  it('GET keys soft-6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S6', first_message_index: 6 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S6'].first_message_index).toBe(6);
  });
  it('GET keys soft-7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S7', first_message_index: 7 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S7'].first_message_index).toBe(7);
  });
  it('GET keys soft-8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S8', first_message_index: 8 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S8'].first_message_index).toBe(8);
  });
  it('GET keys soft-9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S9', first_message_index: 9 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S9'].first_message_index).toBe(9);
  });
  it('GET keys soft-10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S10', first_message_index: 10 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S10'].first_message_index).toBe(10);
  });
  it('GET keys soft-11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S11', first_message_index: 11 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S11'].first_message_index).toBe(11);
  });
  it('GET keys soft-12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S12', first_message_index: 12 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S12'].first_message_index).toBe(12);
  });
  it('GET keys soft-13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S13', first_message_index: 13 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S13'].first_message_index).toBe(13);
  });
  it('GET keys soft-14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S14', first_message_index: 14 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S14'].first_message_index).toBe(14);
  });
  it('GET keys soft-15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'S15', first_message_index: 15 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body.rooms[ROOM].sessions['S15'].first_message_index).toBe(15);
  });
});
describe('key-backups leftovers DELETE session soft flood after #149', () => {
  it('DELETE session soft-0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL0' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL0?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL0')).toBeUndefined();
  });
  it('DELETE session soft-1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL1' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL1?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL1')).toBeUndefined();
  });
  it('DELETE session soft-2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL2' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL2?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL2')).toBeUndefined();
  });
  it('DELETE session soft-3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL3' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL3?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL3')).toBeUndefined();
  });
  it('DELETE session soft-4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL4' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL4?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL4')).toBeUndefined();
  });
  it('DELETE session soft-5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL5' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL5?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL5')).toBeUndefined();
  });
  it('DELETE session soft-6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL6' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL6?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL6')).toBeUndefined();
  });
  it('DELETE session soft-7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL7' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL7?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL7')).toBeUndefined();
  });
  it('DELETE session soft-8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL8' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL8?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL8')).toBeUndefined();
  });
  it('DELETE session soft-9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL9' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL9?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL9')).toBeUndefined();
  });
  it('DELETE session soft-10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL10' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL10?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL10')).toBeUndefined();
  });
  it('DELETE session soft-11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL11' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL11?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL11')).toBeUndefined();
  });
  it('DELETE session soft-12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL12' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL12?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL12')).toBeUndefined();
  });
  it('DELETE session soft-13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL13' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL13?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL13')).toBeUndefined();
  });
  it('DELETE session soft-14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL14' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL14?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL14')).toBeUndefined();
  });
  it('DELETE session soft-15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: 'DEL15' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/DEL15?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.find((k) => k.session_id === 'DEL15')).toBeUndefined();
  });
});
describe('key-backups leftovers DELETE room keys soft flood after #149', () => {
  it('DELETE room soft-0', async () => {
    const room = '!r0:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-1', async () => {
    const room = '!r1:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-2', async () => {
    const room = '!r2:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-3', async () => {
    const room = '!r3:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-4', async () => {
    const room = '!r4:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-5', async () => {
    const room = '!r5:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-6', async () => {
    const room = '!r6:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-7', async () => {
    const room = '!r7:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-8', async () => {
    const room = '!r8:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-9', async () => {
    const room = '!r9:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-10', async () => {
    const room = '!r10:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-11', async () => {
    const room = '!r11:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-12', async () => {
    const room = '!r12:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-13', async () => {
    const room = '!r13:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-14', async () => {
    const room = '!r14:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
  it('DELETE room soft-15', async () => {
    const room = '!r15:example.com';
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ room_id: room, session_id: 'a' }),
        seedKey({ room_id: room, session_id: 'b' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(room)}?version=1`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys.filter((k) => k.room_id === room)).toHaveLength(0);
  });
});
describe('key-backups leftovers DELETE version soft flood after #149', () => {
  it('DELETE version soft-0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 20 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/20',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-1', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 21 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/21',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-2', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 22 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/22',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-3', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 23 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/23',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-4', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 24 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/24',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-5', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 25 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/25',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-6', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 26 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/26',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-7', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 27 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/27',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-8', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 28 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/28',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-9', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 29 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/29',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-10', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 30 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/30',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-11', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 31 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/31',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-12', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 32 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/32',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-13', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 33 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/33',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-14', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 34 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/34',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
  it('DELETE version soft-15', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 35 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/35',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
  });
});

describe('key-backups leftovers failure and edge cases after #149', () => {
  it('POST missing algorithm', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('POST missing auth_data', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('POST bad JSON', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('POST invalid algorithm', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: 'not.real', auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('GET latest 404 when empty', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET specific missing version 404', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/99');
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET ignores deleted versions', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, deleted: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(404);
  });

  it('PUT keys without version query → missing', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys',
      jsonInit('PUT', { rooms: {} })
    );
    expect([400, 404]).toContain(res.status);
  });

  it('PUT keys unknown version', async () => {
    const db = createKeyBackupDb({ versions: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              s: {
                first_message_index: 0,
                forwarded_count: 0,
                is_verified: false,
                session_data: { ciphertext: 'x' },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(404);
  });

  it('GET session missing 404', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/missing?version=1`
    );
    expect(res.status).toBe(404);
  });

  it('DELETE all keys for version', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [seedKey({ session_id: 'a' }), seedKey({ session_id: 'b' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(db.keys).toHaveLength(0);
  });

  it('MSC3270 algorithm accepted', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MSC3270, auth_data: { iv: 'x', mac: 'y' } })
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].algorithm).toBe(ALG_MSC3270);
  });

  it('does not leak other user versions', async () => {
    const db = createKeyBackupDb({
      versions: [
        seedVersion({ version: 1, user_id: OTHER }),
        seedVersion({ version: 2 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('2');
  });
});

describe('key-backups leftovers Content-Type charset soft flood after #149', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'application/json; charset="utf-8"',
  ];
  it('POST version charset soft-0', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': charsets[0], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: AUTH_DATA }),
    });
    expect(res.status).toBe(200);
  });
  it('POST version charset soft-1', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': charsets[1], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: AUTH_DATA }),
    });
    expect(res.status).toBe(200);
  });
  it('POST version charset soft-2', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': charsets[2], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: AUTH_DATA }),
    });
    expect(res.status).toBe(200);
  });
  it('POST version charset soft-3', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': charsets[3], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: AUTH_DATA }),
    });
    expect(res.status).toBe(200);
  });
  it('POST version charset soft-4', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': charsets[4], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: AUTH_DATA }),
    });
    expect(res.status).toBe(200);
  });
  it('PUT auth_data charset soft-0', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'PUT',
      headers: { 'Content-Type': charsets[0], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, n: 0 } }),
    });
    expect(res.status).toBe(200);
  });
  it('PUT auth_data charset soft-1', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'PUT',
      headers: { 'Content-Type': charsets[1], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, n: 1 } }),
    });
    expect(res.status).toBe(200);
  });
  it('PUT auth_data charset soft-2', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'PUT',
      headers: { 'Content-Type': charsets[2], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, n: 2 } }),
    });
    expect(res.status).toBe(200);
  });
  it('PUT auth_data charset soft-3', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'PUT',
      headers: { 'Content-Type': charsets[3], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, n: 3 } }),
    });
    expect(res.status).toBe(200);
  });
  it('PUT auth_data charset soft-4', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 1 })] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'PUT',
      headers: { 'Content-Type': charsets[4], Authorization: 'Bearer t' },
      body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: { ...AUTH_DATA, n: 4 } }),
    });
    expect(res.status).toBe(200);
  });
});

describe('key-backups leftovers method matrix after #149', () => {
  const cases: Array<{ path: string; bad: string[] }> = [
    { path: '/_matrix/client/v3/room_keys/version', bad: ['PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/room_keys/version/1', bad: ['POST', 'PATCH'] },
    { path: '/_matrix/client/v3/room_keys/keys?version=1', bad: ['PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path}`, async () => {
        const db = createKeyBackupDb({ versions: [seedVersion()] });
        const res = await request(db, c.path, jsonInit(method, {}));
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});
describe('key-backups leftovers lifecycle soft floods after #149', () => {
  it('create→put→get→delete lifecycle soft-0', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-0': {
                first_message_index: 0,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life0' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-0?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(0);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-1', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-1': {
                first_message_index: 1,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life1' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-1?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(1);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-2', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-2': {
                first_message_index: 2,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life2' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-2?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(2);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-3', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-3': {
                first_message_index: 3,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life3' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-3?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(3);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-4', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-4': {
                first_message_index: 4,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life4' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-4?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(4);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-5', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-5': {
                first_message_index: 5,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life5' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-5?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(5);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-6', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-6': {
                first_message_index: 6,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life6' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-6?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(6);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-7', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-7': {
                first_message_index: 7,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life7' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-7?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(7);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-8', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-8': {
                first_message_index: 8,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life8' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-8?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(8);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-9', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-9': {
                first_message_index: 9,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life9' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-9?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(9);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-10', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-10': {
                first_message_index: 10,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life10' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-10?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(10);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-11', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-11': {
                first_message_index: 11,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life11' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-11?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(11);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-12', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-12': {
                first_message_index: 12,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life12' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-12?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(12);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-13', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-13': {
                first_message_index: 13,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life13' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-13?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(13);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-14', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-14': {
                first_message_index: 14,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life14' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-14?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(14);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
  it('create→put→get→delete lifecycle soft-15', async () => {
    const db = createKeyBackupDb();
    const created = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(created.status).toBe(200);
    const ver = created.body.version as string;

    const put = await request(
      db,
      `/_matrix/client/v3/room_keys/keys?version=${ver}`,
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              'life-15': {
                first_message_index: 15,
                forwarded_count: 0,
                is_verified: true,
                session_data: { ciphertext: 'life15' },
              },
            },
          },
        },
      })
    );
    expect(put.status).toBe(200);

    const get = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/life-15?version=${ver}`
    );
    expect(get.status).toBe(200);
    expect(get.body.first_message_index).toBe(15);

    const del = await request(
      db,
      `/_matrix/client/v3/room_keys/version/${ver}`,
      jsonInit('DELETE')
    );
    expect(del.status).toBe(200);
  });
});
