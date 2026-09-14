/**
 * Deep route coverage for src/api/key-backups.ts (server-side key backups).
 * Tests-only deepen — no product changes. Exercises version CRUD and
 * key upload/download/delete via Hono app.request() + requireAuth().
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import keyBackups from '../src/api/key-backups';

const SERVER = 'matrix.example.com';
const USER_ID = `@alice:${SERVER}`;
const OTHER_USER = `@bob:${SERVER}`;
const DEVICE_ID = 'DEVICEA';
const ALG_MEGOLM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const ALG_MSC3270 = 'org.matrix.msc3270.v1.aes-hmac-sha2';
const ROOM_A = '!roomA:example.com';
const ROOM_B = '!roomB:example.com';
const SESSION_1 = 'session_one';
const SESSION_2 = 'session_two';

type TokenRow = { user_id: string; device_id: string | null };

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
  version: number;
  room_id: string;
  session_id: string;
  first_message_index: number;
  forwarded_count: number;
  is_verified: number;
  session_data: string;
};

type SqlOp = { sql: string; args: unknown[] };

function createKeyBackupDb(opts: {
  tokensByHash?: Map<string, TokenRow>;
  versions?: VersionRow[];
  keys?: KeyRow[];
  nextVersionId?: number;
} = {}) {
  const tokensByHash = opts.tokensByHash ?? new Map<string, TokenRow>();
  const versions = opts.versions ?? [];
  const keys = opts.keys ?? [];
  const inserts: SqlOp[] = [];
  const updates: SqlOp[] = [];
  const deletes: SqlOp[] = [];
  const state = { nextVersionId: opts.nextVersionId ?? 1 };

  const keyMatch = (k: KeyRow, userId: string, version: unknown, roomId?: string, sessionId?: string) => {
    if (k.user_id !== userId) return false;
    if (String(k.version) !== String(version)) return false;
    if (roomId !== undefined && k.room_id !== roomId) return false;
    if (sessionId !== undefined && k.session_id !== sessionId) return false;
    return true;
  };

  return {
    tokensByHash,
    versions,
    keys,
    inserts,
    updates,
    deletes,
    state,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (normalized.includes('FROM access_tokens') && normalized.includes('token_hash')) {
                const row = tokensByHash.get(args[0] as string);
                if (!row) return null;
                return { user_id: row.user_id, device_id: row.device_id } as T;
              }
              if (normalized.includes('FROM appservice_registrations')) {
                return null;
              }

              // Latest non-deleted backup for user
              if (
                normalized.includes('FROM key_backup_versions') &&
                normalized.includes('ORDER BY version DESC') &&
                normalized.includes('LIMIT 1')
              ) {
                const userId = args[0] as string;
                const matches = versions
                  .filter((v) => v.user_id === userId && v.deleted === 0)
                  .sort((a, b) => b.version - a.version);
                const row = matches[0];
                if (!row) return null;
                return {
                  version: row.version,
                  algorithm: row.algorithm,
                  auth_data: row.auth_data,
                  count: row.count,
                  etag: row.etag,
                } as T;
              }

              // Specific version (full columns)
              if (
                normalized.includes('FROM key_backup_versions') &&
                normalized.includes('SELECT version, algorithm, auth_data, count, etag') &&
                normalized.includes('AND version = ?')
              ) {
                const [userId, version] = args as [string, string | number];
                const row = versions.find(
                  (v) =>
                    v.user_id === userId &&
                    String(v.version) === String(version) &&
                    v.deleted === 0
                );
                if (!row) return null;
                return {
                  version: row.version,
                  algorithm: row.algorithm,
                  auth_data: row.auth_data,
                  count: row.count,
                  etag: row.etag,
                } as T;
              }

              // Existence / etag checks (SELECT version [, etag])
              if (
                normalized.includes('FROM key_backup_versions') &&
                normalized.includes('AND version = ?') &&
                normalized.includes('deleted = 0')
              ) {
                const [userId, version] = args as [string, string | number];
                const row = versions.find(
                  (v) =>
                    v.user_id === userId &&
                    String(v.version) === String(version) &&
                    v.deleted === 0
                );
                if (!row) return null;
                if (normalized.includes('etag')) {
                  return { version: row.version, etag: row.etag } as T;
                }
                return { version: row.version } as T;
              }

              // COUNT(*) of keys
              if (
                normalized.includes('SELECT COUNT(*) as count FROM key_backup_keys')
              ) {
                const [userId, version] = args as [string, string | number];
                const count = keys.filter((k) => keyMatch(k, userId, version)).length;
                return { count } as T;
              }

              // Single session key
              if (
                normalized.includes('FROM key_backup_keys') &&
                normalized.includes('AND session_id = ?') &&
                normalized.includes('SELECT first_message_index')
              ) {
                const [userId, version, roomId, sessionId] = args as [
                  string,
                  string | number,
                  string,
                  string,
                ];
                const row = keys.find((k) => keyMatch(k, userId, version, roomId, sessionId));
                if (!row) return null;
                return {
                  first_message_index: row.first_message_index,
                  forwarded_count: row.forwarded_count,
                  is_verified: row.is_verified,
                  session_data: row.session_data,
                } as T;
              }

              return null;
            },

            async all<T>() {
              // All keys for version
              if (
                normalized.includes('FROM key_backup_keys') &&
                normalized.includes('SELECT room_id, session_id')
              ) {
                const [userId, version] = args as [string, string | number];
                const results = keys
                  .filter((k) => keyMatch(k, userId, version))
                  .map((k) => ({
                    room_id: k.room_id,
                    session_id: k.session_id,
                    first_message_index: k.first_message_index,
                    forwarded_count: k.forwarded_count,
                    is_verified: k.is_verified,
                    session_data: k.session_data,
                  }));
                return { results: results as T[], success: true };
              }

              // Keys for one room
              if (
                normalized.includes('FROM key_backup_keys') &&
                normalized.includes('AND room_id = ?') &&
                normalized.includes('SELECT session_id')
              ) {
                const [userId, version, roomId] = args as [string, string | number, string];
                const results = keys
                  .filter((k) => keyMatch(k, userId, version, roomId))
                  .map((k) => ({
                    session_id: k.session_id,
                    first_message_index: k.first_message_index,
                    forwarded_count: k.forwarded_count,
                    is_verified: k.is_verified,
                    session_data: k.session_data,
                  }));
                return { results: results as T[], success: true };
              }

              return { results: [] as T[], success: true };
            },

            async run() {
              // INSERT version
              if (normalized.includes('INSERT INTO key_backup_versions')) {
                inserts.push({ sql: normalized, args });
                const [userId, algorithm, authData, etag] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const version = state.nextVersionId++;
                versions.push({
                  version,
                  user_id: userId,
                  algorithm,
                  auth_data: authData,
                  etag,
                  count: 0,
                  deleted: 0,
                });
                return { success: true, meta: { changes: 1, last_row_id: version } };
              }

              // Soft-delete version
              if (
                normalized.includes('UPDATE key_backup_versions') &&
                normalized.includes('SET deleted = 1')
              ) {
                updates.push({ sql: normalized, args });
                const [userId, version] = args as [string, string | number];
                const row = versions.find(
                  (v) =>
                    v.user_id === userId &&
                    String(v.version) === String(version) &&
                    v.deleted === 0
                );
                if (!row) {
                  return { success: true, meta: { changes: 0 } };
                }
                row.deleted = 1;
                return { success: true, meta: { changes: 1 } };
              }

              // Update auth_data
              if (
                normalized.includes('UPDATE key_backup_versions') &&
                normalized.includes('SET auth_data = ?')
              ) {
                updates.push({ sql: normalized, args });
                const [authData, userId, version] = args as [string, string, string | number];
                const row = versions.find(
                  (v) => v.user_id === userId && String(v.version) === String(version)
                );
                if (row) row.auth_data = authData;
                return { success: true, meta: { changes: row ? 1 : 0 } };
              }

              // Update count + etag
              if (
                normalized.includes('UPDATE key_backup_versions') &&
                normalized.includes('SET count = ?') &&
                normalized.includes('etag = ?')
              ) {
                updates.push({ sql: normalized, args });
                const [count, etag, userId, version] = args as [
                  number,
                  string,
                  string,
                  string | number,
                ];
                const row = versions.find(
                  (v) => v.user_id === userId && String(v.version) === String(version)
                );
                if (row) {
                  row.count = count;
                  row.etag = etag;
                }
                return { success: true, meta: { changes: row ? 1 : 0 } };
              }

              // Update count=0, etag only (delete-all-keys path)
              if (
                normalized.includes('UPDATE key_backup_versions') &&
                normalized.includes('SET count = 0') &&
                normalized.includes('etag = ?')
              ) {
                updates.push({ sql: normalized, args });
                const [etag, userId, version] = args as [string, string, string | number];
                const row = versions.find(
                  (v) => v.user_id === userId && String(v.version) === String(version)
                );
                if (row) {
                  row.count = 0;
                  row.etag = etag;
                }
                return { success: true, meta: { changes: row ? 1 : 0 } };
              }

              // Upsert key
              if (normalized.includes('INSERT INTO key_backup_keys')) {
                inserts.push({ sql: normalized, args });
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
                  string | number,
                  string,
                  string,
                  number,
                  number,
                  number,
                  string,
                ];
                const existing = keys.find((k) =>
                  keyMatch(k, userId, version, roomId, sessionId)
                );
                if (existing) {
                  existing.first_message_index = firstMessageIndex;
                  existing.forwarded_count = forwardedCount;
                  existing.is_verified = isVerified;
                  existing.session_data = sessionData;
                } else {
                  keys.push({
                    user_id: userId,
                    version: Number(version),
                    room_id: roomId,
                    session_id: sessionId,
                    first_message_index: firstMessageIndex,
                    forwarded_count: forwardedCount,
                    is_verified: isVerified,
                    session_data: sessionData,
                  });
                }
                return { success: true, meta: { changes: 1 } };
              }

              // DELETE keys (all / room / session / cascade from version delete)
              if (normalized.includes('DELETE FROM key_backup_keys')) {
                deletes.push({ sql: normalized, args });
                const before = keys.length;
                if (args.length === 4) {
                  const [userId, version, roomId, sessionId] = args as [
                    string,
                    string | number,
                    string,
                    string,
                  ];
                  for (let i = keys.length - 1; i >= 0; i--) {
                    if (keyMatch(keys[i], userId, version, roomId, sessionId)) {
                      keys.splice(i, 1);
                    }
                  }
                } else if (args.length === 3) {
                  const [userId, version, roomId] = args as [string, string | number, string];
                  for (let i = keys.length - 1; i >= 0; i--) {
                    if (keyMatch(keys[i], userId, version, roomId)) {
                      keys.splice(i, 1);
                    }
                  }
                } else if (args.length === 2) {
                  const [userId, version] = args as [string, string | number];
                  for (let i = keys.length - 1; i >= 0; i--) {
                    if (keyMatch(keys[i], userId, version)) {
                      keys.splice(i, 1);
                    }
                  }
                }
                return { success: true, meta: { changes: before - keys.length } };
              }

              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    tokensByHash: Map<string, TokenRow>;
    versions: VersionRow[];
    keys: KeyRow[];
    inserts: SqlOp[];
    updates: SqlOp[];
    deletes: SqlOp[];
    state: { nextVersionId: number };
  };
}

function makeEnv(opts: {
  db?: ReturnType<typeof createKeyBackupDb>;
  partial?: Partial<Env>;
} = {}): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    DB: opts.db ?? createKeyBackupDb(),
    ...opts.partial,
  } as Env;
}

async function authedEnv(
  opts: {
    userId?: string;
    deviceId?: string | null;
    token?: string;
    versions?: VersionRow[];
    keys?: KeyRow[];
  } = {}
) {
  const token = opts.token ?? `syt_test_token_${Math.random().toString(36).slice(2)}`;
  const hash = await hashToken(token);
  const tokensByHash = new Map<string, TokenRow>([
    [
      hash,
      {
        user_id: opts.userId ?? USER_ID,
        device_id: opts.deviceId === undefined ? DEVICE_ID : opts.deviceId,
      },
    ],
  ]);
  const db = createKeyBackupDb({
    tokensByHash,
    versions: opts.versions,
    keys: opts.keys,
  });
  return { env: makeEnv({ db }), db, token, authHeader: { Authorization: `Bearer ${token}` } };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env
): Promise<Response> {
  return keyBackups.request(`http://localhost${path}`, init, env);
}

async function jsonRequest(
  path: string,
  init: RequestInit,
  env: Env
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(path, init, env);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function authData(publicKey = 'base64pubkey==') {
  return {
    public_key: publicKey,
    signatures: {
      [USER_ID]: { 'ed25519:DEVICEA': 'sigvalue' },
    },
  };
}

function sessionPayload(
  partial: Partial<{
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: Record<string, unknown>;
  }> = {}
) {
  return {
    first_message_index: partial.first_message_index ?? 0,
    forwarded_count: partial.forwarded_count ?? 0,
    is_verified: partial.is_verified ?? true,
    session_data: partial.session_data ?? { ciphertext: 'enc', mac: 'mac', ephemeral: 'eph' },
  };
}

function seedVersion(
  overrides: Partial<VersionRow> & Pick<VersionRow, 'version'> = { version: 1 }
): VersionRow {
  return {
    version: overrides.version,
    user_id: overrides.user_id ?? USER_ID,
    algorithm: overrides.algorithm ?? ALG_MEGOLM,
    auth_data: overrides.auth_data ?? JSON.stringify(authData()),
    etag: overrides.etag ?? 'etag_initial_0001',
    count: overrides.count ?? 0,
    deleted: overrides.deleted ?? 0,
  };
}

function seedKey(
  partial: Partial<KeyRow> & Pick<KeyRow, 'session_id'> = { session_id: SESSION_1 }
): KeyRow {
  return {
    user_id: partial.user_id ?? USER_ID,
    version: partial.version ?? 1,
    room_id: partial.room_id ?? ROOM_A,
    session_id: partial.session_id,
    first_message_index: partial.first_message_index ?? 0,
    forwarded_count: partial.forwarded_count ?? 0,
    is_verified: partial.is_verified ?? 1,
    session_data: partial.session_data ?? JSON.stringify({ ciphertext: 'c', mac: 'm' }),
  };
}

function encRoom(roomId: string): string {
  return encodeURIComponent(roomId);
}

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------

describe('key-backups auth gates', () => {
  it('rejects missing access token on version create', async () => {
    const env = makeEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: authData() }),
      },
      env
    );
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });

  it('rejects unknown bearer token', async () => {
    const env = makeEnv({ db: createKeyBackupDb() });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer totally-unknown-token' },
      },
      env
    );
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('accepts access_token query param as auth', async () => {
    const { env, token } = await authedEnv({
      versions: [seedVersion({ version: 3, etag: 'qauth' })],
    });
    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/version?access_token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      env
    );
    expect(status).toBe(200);
    expect(body.version).toBe('3');
    expect(body.etag).toBe('qauth');
  });
});

// ---------------------------------------------------------------------------
// POST /room_keys/version
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/room_keys/version', () => {
  it('rejects invalid JSON body', async () => {
    const { env, authHeader } = await authedEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: '{not-json',
      },
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('requires algorithm and auth_data', async () => {
    const { env, authHeader } = await authedEnv();
    const missingAlg = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_data: authData() }),
      },
      env
    );
    expect(missingAlg.status).toBe(400);
    expect(missingAlg.body.errcode).toBe('M_MISSING_PARAM');

    const missingAuth = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: ALG_MEGOLM }),
      },
      env
    );
    expect(missingAuth.status).toBe(400);
    expect(missingAuth.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects unsupported algorithm with M_INVALID_PARAM', async () => {
    const { env, authHeader } = await authedEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'm.unknown.algo', auth_data: authData() }),
      },
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
    expect(String(body.error)).toContain(ALG_MEGOLM);
    expect(String(body.error)).toContain(ALG_MSC3270);
  });

  it('creates megolm backup version and returns stringified last_row_id', async () => {
    const { env, db, authHeader } = await authedEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: authData('pk1') }),
      },
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({ version: '1' });
    expect(db.versions).toHaveLength(1);
    expect(db.versions[0]).toMatchObject({
      user_id: USER_ID,
      algorithm: ALG_MEGOLM,
      count: 0,
      deleted: 0,
    });
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('pk1');
    expect(db.versions[0].etag).toMatch(/^[0-9a-f]{16}$/);
  });

  it('creates MSC3270 algorithm backup and increments version ids', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    // nextVersionId defaults to 1; bump so create gets 2 after seeded v1
    db.state.nextVersionId = 2;

    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: ALG_MSC3270, auth_data: authData('pk2') }),
      },
      env
    );
    expect(status).toBe(200);
    expect(body.version).toBe('2');
    expect(db.versions[1].algorithm).toBe(ALG_MSC3270);
  });
});

// ---------------------------------------------------------------------------
// GET /room_keys/version (+ :version)
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v3/room_keys/version', () => {
  it('returns 404 when user has no backups', async () => {
    const { env, authHeader } = await authedEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(404);
    expect(body).toEqual({ errcode: 'M_NOT_FOUND', error: 'No backup found' });
  });

  it('ignores soft-deleted versions when resolving current', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [
        seedVersion({ version: 1, deleted: 1, etag: 'gone' }),
        seedVersion({ version: 2, deleted: 0, etag: 'live', count: 4 }),
      ],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.version).toBe('2');
    expect(body.etag).toBe('live');
    expect(body.count).toBe(4);
    expect(body.algorithm).toBe(ALG_MEGOLM);
    expect(body.auth_data).toEqual(authData());
  });

  it('returns latest version when multiple active exist', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [
        seedVersion({ version: 1, etag: 'old' }),
        seedVersion({ version: 5, etag: 'newest', algorithm: ALG_MSC3270 }),
        seedVersion({ version: 3, etag: 'mid' }),
      ],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.version).toBe('5');
    expect(body.etag).toBe('newest');
    expect(body.algorithm).toBe(ALG_MSC3270);
  });

  it('does not leak another user current backup', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 9, user_id: OTHER_USER, etag: 'bobs' })],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
});

describe('GET /_matrix/client/v3/room_keys/version/:version', () => {
  it('returns 404 for missing or deleted version', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, deleted: 1 })],
    });
    const missing = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/99',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Backup version not found');

    const deleted = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/1',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(deleted.status).toBe(404);
  });

  it('returns parsed auth_data for a specific version', async () => {
    const custom = authData('specific-pk');
    const { env, authHeader } = await authedEnv({
      versions: [
        seedVersion({
          version: 7,
          auth_data: JSON.stringify(custom),
          etag: 'v7etag',
          count: 2,
          algorithm: ALG_MSC3270,
        }),
      ],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/7',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      algorithm: ALG_MSC3270,
      auth_data: custom,
      count: 2,
      etag: 'v7etag',
      version: '7',
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /room_keys/version/:version
// ---------------------------------------------------------------------------

describe('PUT /_matrix/client/v3/room_keys/version/:version', () => {
  it('rejects bad JSON', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: 'not-json',
      },
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('returns 404 when version missing', async () => {
    const { env, authHeader } = await authedEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_data: authData('x') }),
      },
      env
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('updates auth_data when provided and no-ops when omitted', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, auth_data: JSON.stringify(authData('old')) })],
    });

    const updated = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_data: authData('new') }),
      },
      env
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({});
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('new');

    const noop = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: ALG_MEGOLM }),
      },
      env
    );
    expect(noop.status).toBe(200);
    expect(JSON.parse(db.versions[0].auth_data).public_key).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// DELETE /room_keys/version/:version
// ---------------------------------------------------------------------------

describe('DELETE /_matrix/client/v3/room_keys/version/:version', () => {
  it('soft-deletes version and cascades key deletion', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 2, count: 2 })],
      keys: [
        seedKey({ version: 2, session_id: SESSION_1 }),
        seedKey({ version: 2, session_id: SESSION_2, room_id: ROOM_B }),
        seedKey({ version: 1, session_id: 'keep_me' }),
      ],
    });

    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/2',
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.versions.find((v) => v.version === 2)?.deleted).toBe(1);
    expect(db.keys.every((k) => k.version !== 2)).toBe(true);
    expect(db.keys).toHaveLength(1);
    expect(db.keys[0].session_id).toBe('keep_me');
  });

  it('returns 404 when version already deleted or absent', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, deleted: 1 })],
    });
    const gone = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/1',
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(gone.status).toBe(404);

    const absent = await jsonRequest(
      '/_matrix/client/v3/room_keys/version/99',
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(absent.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT keys (bulk / room / session)
// ---------------------------------------------------------------------------

describe('PUT /_matrix/client/v3/room_keys/keys', () => {
  it('requires version query param', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms: {} }),
      },
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
    expect(String(body.error)).toContain('version');
  });

  it('rejects bad JSON and missing version row', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const bad = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: '{',
      },
      env
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errcode).toBe('M_BAD_JSON');

    const missing = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=99',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms: {} }),
      },
      env
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Backup version not found');
  });

  it('upserts multi-room sessions, recounts, and rotates etag', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 'before', count: 0 })],
    });

    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rooms: {
            [ROOM_A]: {
              sessions: {
                [SESSION_1]: sessionPayload({ is_verified: true, first_message_index: 1 }),
                [SESSION_2]: sessionPayload({ is_verified: false, forwarded_count: 3 }),
              },
            },
            [ROOM_B]: {
              sessions: {
                [SESSION_1]: sessionPayload({ session_data: { ciphertext: 'b' } }),
              },
            },
          },
        }),
      },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(typeof body.etag).toBe('string');
    expect(body.etag).not.toBe('before');
    expect(db.keys).toHaveLength(3);
    expect(db.keys.find((k) => k.session_id === SESSION_2)?.is_verified).toBe(0);
    expect(db.keys.find((k) => k.session_id === SESSION_1 && k.room_id === ROOM_A)?.is_verified).toBe(
      1
    );
    expect(db.versions[0].count).toBe(3);
    expect(db.versions[0].etag).toBe(body.etag);

    // Upsert overwrite same session
    const again = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rooms: {
            [ROOM_A]: {
              sessions: {
                [SESSION_1]: sessionPayload({
                  first_message_index: 99,
                  is_verified: false,
                  session_data: { ciphertext: 'updated' },
                }),
              },
            },
          },
        }),
      },
      env
    );
    expect(again.status).toBe(200);
    expect(again.body.count).toBe(3);
    const updated = db.keys.find((k) => k.room_id === ROOM_A && k.session_id === SESSION_1)!;
    expect(updated.first_message_index).toBe(99);
    expect(updated.is_verified).toBe(0);
    expect(JSON.parse(updated.session_data).ciphertext).toBe('updated');
  });

  it('treats missing rooms as empty upload still rotating etag', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 'e0' })],
      keys: [seedKey({ session_id: SESSION_1 })],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.etag).not.toBe('e0');
    expect(db.keys).toHaveLength(1);
  });
});

describe('PUT /_matrix/client/v3/room_keys/keys/:roomId', () => {
  it('requires version and rejects unknown backup', async () => {
    const { env, authHeader } = await authedEnv();
    const noVer = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: {} }),
      },
      env
    );
    expect(noVer.status).toBe(400);
    expect(noVer.body.errcode).toBe('M_MISSING_PARAM');

    const { env: env2, authHeader: h2 } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const missing = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}?version=9`,
      {
        method: 'PUT',
        headers: { ...h2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: { [SESSION_1]: sessionPayload() } }),
      },
      env2
    );
    expect(missing.status).toBe(404);
  });

  it('rejects bad JSON', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}?version=1`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: 'x',
      },
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('decodes URI-encoded room id and upserts sessions', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 'r0' })],
    });
    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}?version=1`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessions: {
            [SESSION_1]: sessionPayload({ is_verified: true }),
            [SESSION_2]: sessionPayload({ is_verified: false, forwarded_count: 2 }),
          },
        }),
      },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(db.keys.every((k) => k.room_id === ROOM_A)).toBe(true);
    expect(db.keys.find((k) => k.session_id === SESSION_2)?.forwarded_count).toBe(2);
    expect(db.versions[0].etag).toBe(body.etag);
  });
});

describe('PUT /_matrix/client/v3/room_keys/keys/:roomId/:sessionId', () => {
  it('requires version / valid JSON / existing backup', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const noVer = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionPayload()),
      },
      env
    );
    expect(noVer.status).toBe(400);

    const bad = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}?version=1`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: 'nope',
      },
      env
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errcode).toBe('M_BAD_JSON');

    const missing = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}?version=404`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionPayload()),
      },
      env
    );
    expect(missing.status).toBe(404);
  });

  it('stores unverified single session and updates count/etag', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 's0', count: 0 })],
    });
    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_B)}/${SESSION_2}?version=1`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          sessionPayload({
            is_verified: false,
            first_message_index: 7,
            forwarded_count: 1,
            session_data: { ciphertext: 'solo' },
          })
        ),
      },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(db.keys).toHaveLength(1);
    expect(db.keys[0]).toMatchObject({
      room_id: ROOM_B,
      session_id: SESSION_2,
      first_message_index: 7,
      forwarded_count: 1,
      is_verified: 0,
    });
    expect(JSON.parse(db.keys[0].session_data).ciphertext).toBe('solo');
  });
});

// ---------------------------------------------------------------------------
// GET keys
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v3/room_keys/keys', () => {
  it('requires version and 404s unknown backup', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const noVer = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(noVer.status).toBe(400);
    expect(noVer.body.errcode).toBe('M_MISSING_PARAM');

    const missing = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=99',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(missing.status).toBe(404);
  });

  it('nests rooms/sessions and maps is_verified 0/1 to boolean', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({
          session_id: SESSION_1,
          room_id: ROOM_A,
          is_verified: 1,
          first_message_index: 2,
          forwarded_count: 4,
          session_data: JSON.stringify({ ciphertext: 'a1' }),
        }),
        seedKey({
          session_id: SESSION_2,
          room_id: ROOM_A,
          is_verified: 0,
          session_data: JSON.stringify({ ciphertext: 'a2' }),
        }),
        seedKey({
          session_id: SESSION_1,
          room_id: ROOM_B,
          is_verified: 1,
          session_data: JSON.stringify({ ciphertext: 'b1' }),
        }),
      ],
    });

    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    const rooms = body.rooms as Record<string, { sessions: Record<string, unknown> }>;
    expect(Object.keys(rooms).sort()).toEqual([ROOM_A, ROOM_B].sort());
    expect(rooms[ROOM_A].sessions[SESSION_1]).toEqual({
      first_message_index: 2,
      forwarded_count: 4,
      is_verified: true,
      session_data: { ciphertext: 'a1' },
    });
    expect(rooms[ROOM_A].sessions[SESSION_2]).toMatchObject({ is_verified: false });
    expect(rooms[ROOM_B].sessions[SESSION_1]).toMatchObject({
      session_data: { ciphertext: 'b1' },
    });
  });

  it('returns empty rooms object when version has no keys', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({ rooms: {} });
  });
});

describe('GET /_matrix/client/v3/room_keys/keys/:roomId', () => {
  it('requires version and validates backup existence', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    expect(
      (
        await jsonRequest(
          `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}`,
          { method: 'GET', headers: authHeader },
          env
        )
      ).status
    ).toBe(400);
    expect(
      (
        await jsonRequest(
          `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}?version=404`,
          { method: 'GET', headers: authHeader },
          env
        )
      ).status
    ).toBe(404);
  });

  it('returns empty sessions for room with no keys and decodes room id', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ room_id: ROOM_B, session_id: SESSION_1 })],
    });
    const empty = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}?version=1`,
      { method: 'GET', headers: authHeader },
      env
    );
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ sessions: {} });

    const filled = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_B)}?version=1`,
      { method: 'GET', headers: authHeader },
      env
    );
    expect(filled.status).toBe(200);
    const sessions = filled.body.sessions as Record<string, { is_verified: boolean }>;
    expect(sessions[SESSION_1].is_verified).toBe(true);
  });
});

describe('GET /_matrix/client/v3/room_keys/keys/:roomId/:sessionId', () => {
  it('requires version / backup / session existence', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
      keys: [seedKey({ session_id: SESSION_1 })],
    });
    expect(
      (
        await jsonRequest(
          `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}`,
          { method: 'GET', headers: authHeader },
          env
        )
      ).body.errcode
    ).toBe('M_MISSING_PARAM');

    expect(
      (
        await jsonRequest(
          `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}?version=9`,
          { method: 'GET', headers: authHeader },
          env
        )
      ).status
    ).toBe(404);

    const missingKey = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_2}?version=1`,
      { method: 'GET', headers: authHeader },
      env
    );
    expect(missingKey.status).toBe(404);
    expect(missingKey.body).toEqual({ errcode: 'M_NOT_FOUND', error: 'Key not found' });
  });

  it('returns single session payload with boolean is_verified', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
      keys: [
        seedKey({
          session_id: SESSION_1,
          is_verified: 0,
          first_message_index: 11,
          forwarded_count: 5,
          session_data: JSON.stringify({ ciphertext: 'one' }),
        }),
      ],
    });
    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}?version=1`,
      { method: 'GET', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      first_message_index: 11,
      forwarded_count: 5,
      is_verified: false,
      session_data: { ciphertext: 'one' },
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE keys
// ---------------------------------------------------------------------------

describe('DELETE /_matrix/client/v3/room_keys/keys', () => {
  it('requires version query param', async () => {
    const { env, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1 })],
    });
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys',
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('wipes all keys for version and forces count=0 with new etag', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 'wipe0', count: 2 })],
      keys: [
        seedKey({ session_id: SESSION_1 }),
        seedKey({ session_id: SESSION_2, room_id: ROOM_B }),
        seedKey({ version: 2, session_id: 'other_version' }),
      ],
    });
    // also seed version 2 so other keys stay
    db.versions.push(seedVersion({ version: 2, etag: 'v2' }));

    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(typeof body.etag).toBe('string');
    expect(body.etag).not.toBe('wipe0');
    expect(db.keys.every((k) => k.version !== 1)).toBe(true);
    expect(db.keys).toHaveLength(1);
    expect(db.versions.find((v) => v.version === 1)?.count).toBe(0);
    expect(db.versions.find((v) => v.version === 1)?.etag).toBe(body.etag);
  });

  it('still returns count 0 etag when version row is absent', async () => {
    const { env, authHeader } = await authedEnv();
    const { status, body } = await jsonRequest(
      '/_matrix/client/v3/room_keys/keys?version=1',
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(typeof body.etag).toBe('string');
  });
});

describe('DELETE /_matrix/client/v3/room_keys/keys/:roomId', () => {
  it('requires version and deletes only that room', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 'rm0', count: 3 })],
      keys: [
        seedKey({ room_id: ROOM_A, session_id: SESSION_1 }),
        seedKey({ room_id: ROOM_A, session_id: SESSION_2 }),
        seedKey({ room_id: ROOM_B, session_id: SESSION_1 }),
      ],
    });

    const noVer = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(noVer.status).toBe(400);

    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}?version=1`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(db.keys).toHaveLength(1);
    expect(db.keys[0].room_id).toBe(ROOM_B);
    expect(db.versions[0].count).toBe(1);
    expect(db.versions[0].etag).toBe(body.etag);
  });
});

describe('DELETE /_matrix/client/v3/room_keys/keys/:roomId/:sessionId', () => {
  it('requires version and deletes a single session then recounts', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, etag: 'd0', count: 2 })],
      keys: [
        seedKey({ session_id: SESSION_1 }),
        seedKey({ session_id: SESSION_2 }),
      ],
    });

    const noVer = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(noVer.status).toBe(400);

    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_1}?version=1`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(db.keys.map((k) => k.session_id)).toEqual([SESSION_2]);
    expect(db.versions[0].etag).not.toBe('d0');
  });

  it('deleting a non-existent session still recounts remaining keys', async () => {
    const { env, db, authHeader } = await authedEnv({
      versions: [seedVersion({ version: 1, count: 1 })],
      keys: [seedKey({ session_id: SESSION_1 })],
    });
    const { status, body } = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/missing?version=1`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(db.keys).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow across version + keys
// ---------------------------------------------------------------------------

describe('key-backups end-to-end flow', () => {
  it('create → upload → download → delete session → soft-delete version', async () => {
    const { env, db, authHeader } = await authedEnv();

    const created = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: ALG_MEGOLM, auth_data: authData('e2e') }),
      },
      env
    );
    expect(created.status).toBe(200);
    const version = created.body.version as string;

    const uploaded = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys?version=${version}`,
      {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rooms: {
            [ROOM_A]: {
              sessions: {
                [SESSION_1]: sessionPayload({ is_verified: true }),
                [SESSION_2]: sessionPayload({ is_verified: false }),
              },
            },
          },
        }),
      },
      env
    );
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.count).toBe(2);

    const downloaded = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys?version=${version}`,
      { method: 'GET', headers: authHeader },
      env
    );
    expect(downloaded.status).toBe(200);
    const rooms = downloaded.body.rooms as Record<
      string,
      { sessions: Record<string, { is_verified: boolean }> }
    >;
    expect(rooms[ROOM_A].sessions[SESSION_1].is_verified).toBe(true);
    expect(rooms[ROOM_A].sessions[SESSION_2].is_verified).toBe(false);

    const deletedSession = await jsonRequest(
      `/_matrix/client/v3/room_keys/keys/${encRoom(ROOM_A)}/${SESSION_2}?version=${version}`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(deletedSession.status).toBe(200);
    expect(deletedSession.body.count).toBe(1);

    const current = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(current.status).toBe(200);
    expect(current.body.count).toBe(1);
    expect(current.body.version).toBe(version);

    const soft = await jsonRequest(
      `/_matrix/client/v3/room_keys/version/${version}`,
      { method: 'DELETE', headers: authHeader },
      env
    );
    expect(soft.status).toBe(200);
    expect(db.versions[0].deleted).toBe(1);
    expect(db.keys).toHaveLength(0);

    const after = await jsonRequest(
      '/_matrix/client/v3/room_keys/version',
      { method: 'GET', headers: authHeader },
      env
    );
    expect(after.status).toBe(404);
  });
});
