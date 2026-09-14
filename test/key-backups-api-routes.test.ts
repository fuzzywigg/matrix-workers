/**
 * TOKENMAXX HEAVY deepen after #89/#90 — different slice: key-backups API routes.
 * Avoids oauth (#90) and spaces (#89). Tests-only — no product inventing.
 * Exercises version CRUD + key put/get/delete granularities via Hono app.request().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const PINNED_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PINNED_ETAG = 'aaaaaaaabbbbcccc';

describe('key-backups POST /room_keys/version', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(db.inserts).toEqual([]);
  });

  it('rejects missing algorithm / auth_data with M_MISSING_PARAM', async () => {
    const db = createKeyBackupDb();
    const a = await request(db, '/_matrix/client/v3/room_keys/version', jsonInit('POST', {}));
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('algorithm and auth_data required'),
    });

    const b = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM })
    );
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects unknown algorithm with M_INVALID_PARAM listing allowlist', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: 'm.bad.algorithm', auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: expect.stringContaining(ALG_MEGOLM),
    });
    expect((res.body as { error: string }).error).toContain(ALG_MSC3270);
  });

  it('creates megolm backup and returns stringified version from last_row_id', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '1' });
    expect(db.versions[0]).toMatchObject({
      version: 1,
      user_id: USER,
      algorithm: ALG_MEGOLM,
      auth_data: JSON.stringify(AUTH_DATA),
      etag: PINNED_ETAG,
      count: 0,
      deleted: 0,
    });
    expect(db.inserts[0].args).toEqual([USER, ALG_MEGOLM, JSON.stringify(AUTH_DATA), PINNED_ETAG]);
  });

  it('accepts MSC3270 aes-hmac-sha2 algorithm', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ version: 3 })] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MSC3270, auth_data: { public_key: 'k' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '4' });
    expect(db.versions.at(-1)?.algorithm).toBe(ALG_MSC3270);
  });
});

describe('key-backups GET /room_keys/version', () => {
  it('returns 404 No backup found when no active versions', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ errcode: 'M_NOT_FOUND', error: 'No backup found' });
  });

  it('excludes soft-deleted versions and returns latest active', async () => {
    const db = createKeyBackupDb({
      versions: [
        seedVersion({ version: 1, etag: 'old', deleted: 0 }),
        seedVersion({ version: 2, etag: 'gone', deleted: 1, count: 9 }),
        seedVersion({
          version: 3,
          etag: 'newest',
          count: 2,
          auth_data: JSON.stringify({ public_key: 'new' }),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      algorithm: ALG_MEGOLM,
      auth_data: { public_key: 'new' },
      count: 2,
      etag: 'newest',
      version: '3',
    });
  });

  it('returns 404 when only soft-deleted versions exist', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, deleted: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'No backup found' });
  });

  it('ignores other users versions when selecting current', async () => {
    const db = createKeyBackupDb({
      versions: [
        seedVersion({ version: 9, user_id: OTHER, etag: 'bob' }),
        seedVersion({ version: 2, etag: 'alice' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: '2', etag: 'alice' });
  });
});

describe('key-backups GET /room_keys/version/:version', () => {
  it('returns 404 for missing or deleted version', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, deleted: 1 })],
    });
    const missing = await request(db, '/_matrix/client/v3/room_keys/version/99');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'Backup version not found',
    });

    const deleted = await request(db, '/_matrix/client/v3/room_keys/version/1');
    expect(deleted.status).toBe(404);
    expect(deleted.body).toMatchObject({ error: 'Backup version not found' });
  });

  it('returns the same response shape as current-version GET', async () => {
    const db = createKeyBackupDb({
      versions: [
        seedVersion({
          version: 7,
          count: 4,
          etag: 'e7',
          algorithm: ALG_MSC3270,
          auth_data: JSON.stringify({ public_key: 'p7' }),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      algorithm: ALG_MSC3270,
      auth_data: { public_key: 'p7' },
      count: 4,
      etag: 'e7',
      version: '7',
    });
  });
});

describe('key-backups PUT /room_keys/version/:version', () => {
  it('rejects bad JSON', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns 404 when version missing', async () => {
    const db = createKeyBackupDb();
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/1',
      jsonInit('PUT', { auth_data: { public_key: 'x' } })
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Backup version not found' });
  });

  it('updates auth_data when provided and returns {}', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const next = { public_key: 'rotated', signatures: {} };
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/1',
      jsonInit('PUT', { auth_data: next })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.versions[0].auth_data).toBe(JSON.stringify(next));
    expect(db.updates.some((u) => u.sql.includes('SET auth_data'))).toBe(true);
  });

  it('no-ops UPDATE when auth_data omitted but still returns {}', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ auth_data: JSON.stringify({ public_key: 'keep' }) })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/1',
      jsonInit('PUT', { algorithm: ALG_MEGOLM })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.versions[0].auth_data).toBe(JSON.stringify({ public_key: 'keep' }));
    expect(db.updates.filter((u) => u.sql.includes('SET auth_data'))).toHaveLength(0);
  });
});

describe('key-backups DELETE /room_keys/version/:version', () => {
  it('returns 404 when soft-delete affects zero rows', async () => {
    const db = createKeyBackupDb();
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Backup version not found' });
  });

  it('soft-deletes the version and deletes all keys for it', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 }), seedVersion({ version: 2 })],
      keys: [
        seedKey({ version: '1', session_id: 's1' }),
        seedKey({ version: '1', session_id: 's2' }),
        seedKey({ version: '2', session_id: 'keep' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.versions.find((v) => v.version === 1)?.deleted).toBe(1);
    expect(db.versions.find((v) => v.version === 2)?.deleted).toBe(0);
    expect(db.keys.map((k) => k.session_id)).toEqual(['keep']);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM key_backup_keys'))).toBe(true);
  });

  it('does not soft-delete an already-deleted version', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, deleted: 1 })],
      keys: [seedKey({ version: '1' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/version/1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(db.keys).toHaveLength(1);
  });
});

describe('key-backups PUT /room_keys/keys (bulk)', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires version query param', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys',
      jsonInit('PUT', { rooms: {} })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('version'),
    });
  });

  it('rejects bad JSON', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns 404 for unknown or soft-deleted version', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1, deleted: 1 })],
    });
    const gone = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', { rooms: {} })
    );
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ error: 'Backup version not found' });

    const missing = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=99',
      jsonInit('PUT', { rooms: {} })
    );
    expect(missing.status).toBe(404);
  });

  it('upserts multi-room sessions mapping is_verified bool→0/1 and refreshes count/etag', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              s1: {
                first_message_index: 1,
                forwarded_count: 2,
                is_verified: true,
                session_data: { a: 1 },
              },
              s2: {
                first_message_index: 0,
                forwarded_count: 0,
                is_verified: false,
                session_data: { b: 2 },
              },
            },
          },
          '!other:example.com': {
            sessions: {
              o1: {
                first_message_index: 3,
                forwarded_count: 1,
                is_verified: true,
                session_data: { c: 3 },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3, etag: PINNED_ETAG });
    expect(db.keys).toHaveLength(3);
    expect(db.keys.find((k) => k.session_id === 's1')?.is_verified).toBe(1);
    expect(db.keys.find((k) => k.session_id === 's2')?.is_verified).toBe(0);
    expect(db.versions[0].count).toBe(3);
    expect(db.versions[0].etag).toBe(PINNED_ETAG);
  });

  it('handles empty rooms / missing sessions without inserting keys but still bumps etag', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ etag: 'before' })],
      keys: [seedKey({ session_id: 'pre' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', { rooms: { [ROOM]: {} } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, etag: PINNED_ETAG });
    expect(db.keys.map((k) => k.session_id)).toEqual(['pre']);
    expect(db.versions[0].etag).toBe(PINNED_ETAG);
  });

  it('overwrites an existing session on conflict (ON CONFLICT DO UPDATE)', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [
        seedKey({
          session_id: 's1',
          first_message_index: 0,
          session_data: JSON.stringify({ old: true }),
          is_verified: 0,
        }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              s1: {
                first_message_index: 9,
                forwarded_count: 4,
                is_verified: true,
                session_data: { new: true },
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(db.keys).toHaveLength(1);
    expect(db.keys[0]).toMatchObject({
      first_message_index: 9,
      forwarded_count: 4,
      is_verified: 1,
      session_data: JSON.stringify({ new: true }),
    });
  });

  it('uses count 0 when COUNT(*) returns null', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()], nullCount: true });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {
        rooms: {
          [ROOM]: {
            sessions: {
              s1: {
                first_message_index: 0,
                forwarded_count: 0,
                is_verified: false,
                session_data: {},
              },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, etag: PINNED_ETAG });
  });
});

describe('key-backups PUT room/session scoped keys', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes percent-encoded roomId on room-scoped put', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`,
      jsonInit('PUT', {
        sessions: {
          [SESSION]: {
            first_message_index: 0,
            forwarded_count: 0,
            is_verified: true,
            session_data: { x: 1 },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, etag: PINNED_ETAG });
    expect(db.keys[0].room_id).toBe(ROOM);
  });

  it('room put: missing version / missing backup / bad JSON', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const noVer = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}`,
      jsonInit('PUT', { sessions: {} })
    );
    expect(noVer.status).toBe(400);
    expect(noVer.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const bad = await request(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'x',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ errcode: 'M_BAD_JSON' });

    const missing = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=99`,
      jsonInit('PUT', { sessions: {} })
    );
    expect(missing.status).toBe(404);
  });

  it('single-session put upserts and returns refreshed count/etag', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`,
      jsonInit('PUT', {
        first_message_index: 5,
        forwarded_count: 1,
        is_verified: false,
        session_data: { ciphertext: 'z' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, etag: PINNED_ETAG });
    expect(db.keys[0]).toMatchObject({
      session_id: SESSION,
      first_message_index: 5,
      is_verified: 0,
      session_data: JSON.stringify({ ciphertext: 'z' }),
    });
  });

  it('single-session put requires version and existing backup', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ deleted: 1 })] });
    const noVer = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}`,
      jsonInit('PUT', {
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: false,
        session_data: {},
      })
    );
    expect(noVer.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const gone = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`,
      jsonInit('PUT', {
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: false,
        session_data: {},
      })
    );
    expect(gone.status).toBe(404);
  });

  it('single-session put rejects bad JSON', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: 'nope',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
});

describe('key-backups GET /room_keys/keys', () => {
  it('requires version and existing backup', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const noVer = await request(db, '/_matrix/client/v3/room_keys/keys');
    expect(noVer.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const gone = await request(db, '/_matrix/client/v3/room_keys/keys?version=99');
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ error: 'Backup version not found' });
  });

  it('returns empty rooms object when no keys stored', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rooms: {} });
  });

  it('groups keys by room and maps is_verified 1→true / 0→false', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [
        seedKey({
          session_id: 'a',
          is_verified: 1,
          first_message_index: 1,
          forwarded_count: 2,
          session_data: JSON.stringify({ a: true }),
        }),
        seedKey({
          session_id: 'b',
          is_verified: 0,
          session_data: JSON.stringify({ b: true }),
        }),
        seedKey({
          room_id: '!other:example.com',
          session_id: 'c',
          is_verified: 1,
          session_data: JSON.stringify({ c: true }),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rooms: {
        [ROOM]: {
          sessions: {
            a: {
              first_message_index: 1,
              forwarded_count: 2,
              is_verified: true,
              session_data: { a: true },
            },
            b: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: false,
              session_data: { b: true },
            },
          },
        },
        '!other:example.com': {
          sessions: {
            c: {
              first_message_index: 0,
              forwarded_count: 0,
              is_verified: true,
              session_data: { c: true },
            },
          },
        },
      },
    });
  });
});

describe('key-backups GET room/session scoped keys', () => {
  it('room GET returns sessions map for decoded roomId only', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [
        seedKey({ session_id: 'in', session_data: JSON.stringify({ in: 1 }), is_verified: 1 }),
        seedKey({
          room_id: '!other:example.com',
          session_id: 'out',
          session_data: JSON.stringify({ out: 1 }),
        }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessions: {
        in: {
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: true,
          session_data: { in: 1 },
        },
      },
    });
  });

  it('room GET requires version and existing backup; empty room → {}', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const noVer = await request(db, `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}`);
    expect(noVer.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const empty = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`
    );
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ sessions: {} });

    const gone = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=9`
    );
    expect(gone.status).toBe(404);
  });

  it('session GET miss → 404 Key not found; hit returns four fields', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [
        seedKey({
          session_id: SESSION,
          first_message_index: 8,
          forwarded_count: 3,
          is_verified: 1,
          session_data: JSON.stringify({ ciphertext: 'ok' }),
        }),
      ],
    });

    const miss = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/missing?version=1`
    );
    expect(miss.status).toBe(404);
    expect(miss.body).toEqual({ errcode: 'M_NOT_FOUND', error: 'Key not found' });

    const hit = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`
    );
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({
      first_message_index: 8,
      forwarded_count: 3,
      is_verified: true,
      session_data: { ciphertext: 'ok' },
    });
  });

  it('session GET requires version and existing backup', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ deleted: 1 })] });
    const noVer = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}`
    );
    expect(noVer.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const gone = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`
    );
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ error: 'Backup version not found' });
  });
});

describe('key-backups DELETE /room_keys/keys', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires version query param on all DELETE variants', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    for (const path of [
      '/_matrix/client/v3/room_keys/keys',
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}`,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}`,
    ]) {
      const res = await request(db, path, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
    }
  });

  it('delete-all clears keys, forces count 0, and returns new etag (even if version row missing)', async () => {
    const db = createKeyBackupDb({
      keys: [seedKey({ session_id: 'a' }), seedKey({ session_id: 'b' })],
    });
    // Documents current product behavior: no version existence check on DELETE-all.
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, etag: PINNED_ETAG });
    expect(db.keys).toHaveLength(0);
  });

  it('delete-all with existing version resets count/etag on the version row', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ count: 5, etag: 'old' })],
      keys: [seedKey({ session_id: 'a' })],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, etag: PINNED_ETAG });
    expect(db.versions[0].count).toBe(0);
    expect(db.versions[0].etag).toBe(PINNED_ETAG);
  });

  it('delete-room removes only that room and recounts remaining keys', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ count: 3 })],
      keys: [
        seedKey({ session_id: 'r1' }),
        seedKey({ session_id: 'r2' }),
        seedKey({ room_id: '!keep:example.com', session_id: 'k1' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, etag: PINNED_ETAG });
    expect(db.keys.map((k) => k.session_id)).toEqual(['k1']);
    expect(db.versions[0].count).toBe(1);
  });

  it('delete-session removes one key and recounts', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [
        seedKey({ session_id: SESSION }),
        seedKey({ session_id: 'keep' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, etag: PINNED_ETAG });
    expect(db.keys.map((k) => k.session_id)).toEqual(['keep']);
  });

  it('delete-room/session decode percent-encoded room ids', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [seedKey({ session_id: SESSION })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/${SESSION}?version=1`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(db.keys).toHaveLength(0);
    expect(db.deletes[0].args[2]).toBe(ROOM);
  });

  it('delete-room with null COUNT uses 0', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion()],
      keys: [seedKey()],
      nullCount: true,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, etag: PINNED_ETAG });
  });
});

describe('key-backups TOKENMAXX etag / auth_data edges after #90', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(PINNED_UUID);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generateEtag strips hyphens and truncates to 16 chars (via create)', async () => {
    const db = createKeyBackupDb();
    await request(
      db,
      '/_matrix/client/v3/room_keys/version',
      jsonInit('POST', { algorithm: ALG_MEGOLM, auth_data: AUTH_DATA })
    );
    expect(db.versions[0].etag).toBe(PINNED_ETAG);
    expect(db.versions[0].etag).toHaveLength(16);
    expect(db.versions[0].etag).not.toContain('-');
  });

  it('PUT version with empty-object auth_data still updates (truthy object)', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/version/1',
      jsonInit('PUT', { auth_data: {} })
    );
    expect(res.status).toBe(200);
    expect(db.versions[0].auth_data).toBe('{}');
  });

  it('bulk put with rooms:undefined treats as empty via rooms || {}', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion({ etag: 'e0' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/room_keys/keys?version=1',
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, etag: PINNED_ETAG });
    expect(db.keys).toHaveLength(0);
  });

  it('room put with sessions:undefined inserts nothing but refreshes etag', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    const res = await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}?version=1`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, etag: PINNED_ETAG });
  });

  it('is_verified truthiness: non-boolean truthy/falsy values map via ? 1 : 0', async () => {
    const db = createKeyBackupDb({ versions: [seedVersion()] });
    await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/t?version=1`,
      jsonInit('PUT', {
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 1 as unknown as boolean,
        session_data: {},
      })
    );
    await request(
      db,
      `/_matrix/client/v3/room_keys/keys/${ROOM_ENC}/f?version=1`,
      jsonInit('PUT', {
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 0 as unknown as boolean,
        session_data: {},
      })
    );
    expect(db.keys.find((k) => k.session_id === 't')?.is_verified).toBe(1);
    expect(db.keys.find((k) => k.session_id === 'f')?.is_verified).toBe(0);
  });

  it('GET all keys does not include other users or other versions', async () => {
    const db = createKeyBackupDb({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({ session_id: 'mine' }),
        seedKey({ user_id: OTHER, session_id: 'bob' }),
        seedKey({ version: '2', session_id: 'v2' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/room_keys/keys?version=1');
    expect(res.status).toBe(200);
    const rooms = (res.body as { rooms: Record<string, { sessions: Record<string, unknown> }> })
      .rooms;
    expect(Object.keys(rooms[ROOM].sessions)).toEqual(['mine']);
  });
});
