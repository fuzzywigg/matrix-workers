/**
 * TOKENMAXX HEAVY deepen after #85/#87/#88 — different slice: key-backups helpers + room_keys routes.
 * Avoids spaces (#89), versions/well-known (#87), server-notice (#85), event-auth (#88), VoIP/TURN (#80/#82).
 * Tests only (+ export-only src changes for testability). No product inventing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', AUTH_USER);
      c.set('deviceId', 'DEVICE1');
      await next();
    };
  },
}));

import keyBackups, {
  VALID_BACKUP_ALGORITHMS,
  isValidBackupAlgorithm,
  generateEtag,
  formatBackupVersionResponse,
  mapKeyRowToSession,
  groupBackupKeysByRoom,
  verifiedFlag,
  sessionUpsertValues,
  type KeyBackupData,
  type KeyBackupKeyRow,
  type KeyBackupVersionRow,
} from '../src/api/key-backups';
import type { Env } from '../src/types';

const AUTH_USER = '@alice:example.com';
const OTHER_USER = '@bob:example.com';
const MEGOLM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const MSC3270 = 'org.matrix.msc3270.v1.aes-hmac-sha2';
const ROOM_A = '!roomA:example.com';
const ROOM_B = '!roomB:example.com';

// ---------------------------------------------------------------------------
// In-memory D1 for key_backup_versions + key_backup_keys
// ---------------------------------------------------------------------------

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

type BackupStore = {
  versions: VersionRow[];
  keys: KeyRow[];
  nextVersion: number;
  sqlLog: string[];
};

function createBackupDb(seed?: Partial<BackupStore>): D1Database & { store: BackupStore } {
  const store: BackupStore = {
    versions: seed?.versions ? [...seed.versions] : [],
    keys: seed?.keys ? [...seed.keys] : [],
    nextVersion: seed?.nextVersion ?? 1,
    sqlLog: [],
  };

  const normalizeVersion = (v: unknown) => String(v);

  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              // Latest non-deleted version for user
              if (
                sql.includes('FROM key_backup_versions') &&
                sql.includes('ORDER BY version DESC') &&
                sql.includes('LIMIT 1')
              ) {
                const [userId] = args as [string];
                const row = store.versions
                  .filter((v) => v.user_id === userId && v.deleted === 0)
                  .sort((a, b) => b.version - a.version)[0];
                return (row
                  ? {
                      version: row.version,
                      algorithm: row.algorithm,
                      auth_data: row.auth_data,
                      count: row.count,
                      etag: row.etag,
                    }
                  : null) as T;
              }

              // Specific version (SELECT version, algorithm... OR SELECT version, etag... OR SELECT version)
              if (
                sql.includes('FROM key_backup_versions') &&
                sql.includes('version = ?') &&
                sql.includes('deleted = 0') &&
                !sql.includes('UPDATE') &&
                !sql.includes('INSERT')
              ) {
                const [userId, version] = args as [string, string | number];
                const row = store.versions.find(
                  (v) =>
                    v.user_id === userId &&
                    String(v.version) === normalizeVersion(version) &&
                    v.deleted === 0
                );
                if (!row) return null as T;
                if (sql.includes('algorithm') && sql.includes('auth_data')) {
                  return {
                    version: row.version,
                    algorithm: row.algorithm,
                    auth_data: row.auth_data,
                    count: row.count,
                    etag: row.etag,
                  } as T;
                }
                if (sql.includes('etag')) {
                  return { version: row.version, etag: row.etag } as T;
                }
                return { version: row.version } as T;
              }

              // COUNT keys
              if (sql.includes('COUNT(*)') && sql.includes('FROM key_backup_keys')) {
                const [userId, version] = args as [string, string];
                const count = store.keys.filter(
                  (k) => k.user_id === userId && k.version === normalizeVersion(version)
                ).length;
                return { count } as T;
              }

              // Single session key
              if (
                sql.includes('FROM key_backup_keys') &&
                sql.includes('session_id = ?') &&
                !sql.includes('DELETE')
              ) {
                const [userId, version, roomId, sessionId] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const row = store.keys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.version === normalizeVersion(version) &&
                    k.room_id === roomId &&
                    k.session_id === sessionId
                );
                return (row
                  ? {
                      first_message_index: row.first_message_index,
                      forwarded_count: row.forwarded_count,
                      is_verified: row.is_verified,
                      session_data: row.session_data,
                    }
                  : null) as T;
              }

              return null as T;
            },

            async all<T>() {
              // All keys for version
              if (
                sql.includes('FROM key_backup_keys') &&
                sql.includes('SELECT room_id, session_id')
              ) {
                const [userId, version] = args as [string, string];
                const results = store.keys
                  .filter(
                    (k) => k.user_id === userId && k.version === normalizeVersion(version)
                  )
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

              // Keys for one room
              if (
                sql.includes('FROM key_backup_keys') &&
                sql.includes('room_id = ?') &&
                sql.includes('SELECT session_id')
              ) {
                const [userId, version, roomId] = args as [string, string, string];
                const results = store.keys
                  .filter(
                    (k) =>
                      k.user_id === userId &&
                      k.version === normalizeVersion(version) &&
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

            async run() {
              // INSERT version
              if (sql.includes('INSERT INTO key_backup_versions')) {
                const [userId, algorithm, authData, etag] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const version = store.nextVersion++;
                store.versions.push({
                  version,
                  user_id: userId,
                  algorithm,
                  auth_data: authData,
                  etag,
                  count: 0,
                  deleted: 0,
                });
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: version, duration: 0, size_after: 0 },
                  results: [],
                };
              }

              // Soft-delete version
              if (sql.includes('UPDATE key_backup_versions') && sql.includes('SET deleted = 1')) {
                const [userId, version] = args as [string, string];
                const row = store.versions.find(
                  (v) =>
                    v.user_id === userId &&
                    String(v.version) === normalizeVersion(version) &&
                    v.deleted === 0
                );
                if (!row) {
                  return {
                    success: true,
                    meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0 },
                    results: [],
                  };
                }
                row.deleted = 1;
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: row.version, duration: 0, size_after: 0 },
                  results: [],
                };
              }

              // Update auth_data
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET auth_data')
              ) {
                const [authData, userId, version] = args as [string, string, string];
                const row = store.versions.find(
                  (v) =>
                    v.user_id === userId && String(v.version) === normalizeVersion(version)
                );
                if (row) row.auth_data = authData;
                return {
                  success: true,
                  meta: { changes: row ? 1 : 0, last_row_id: 0, duration: 0, size_after: 0 },
                  results: [],
                };
              }

              // Update count + etag
              if (
                sql.includes('UPDATE key_backup_versions') &&
                sql.includes('SET count')
              ) {
                if (sql.includes('count = 0')) {
                  const [etag, userId, version] = args as [string, string, string];
                  const row = store.versions.find(
                    (v) =>
                      v.user_id === userId && String(v.version) === normalizeVersion(version)
                  );
                  if (row) {
                    row.count = 0;
                    row.etag = etag;
                  }
                } else {
                  const [count, etag, userId, version] = args as [
                    number,
                    string,
                    string,
                    string,
                  ];
                  const row = store.versions.find(
                    (v) =>
                      v.user_id === userId && String(v.version) === normalizeVersion(version)
                  );
                  if (row) {
                    row.count = count;
                    row.etag = etag;
                  }
                }
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: 0, duration: 0, size_after: 0 },
                  results: [],
                };
              }

              // Upsert key
              if (sql.includes('INSERT INTO key_backup_keys')) {
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
                const existing = store.keys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.version === normalizeVersion(version) &&
                    k.room_id === roomId &&
                    k.session_id === sessionId
                );
                if (existing) {
                  existing.first_message_index = firstMessageIndex;
                  existing.forwarded_count = forwardedCount;
                  existing.is_verified = isVerified;
                  existing.session_data = sessionData;
                } else {
                  store.keys.push({
                    user_id: userId,
                    version: normalizeVersion(version),
                    room_id: roomId,
                    session_id: sessionId,
                    first_message_index: firstMessageIndex,
                    forwarded_count: forwardedCount,
                    is_verified: isVerified,
                    session_data: sessionData,
                  });
                }
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: 0, duration: 0, size_after: 0 },
                  results: [],
                };
              }

              // DELETE keys (all / room / session / version cascade)
              if (sql.includes('DELETE FROM key_backup_keys')) {
                const before = store.keys.length;
                if (sql.includes('session_id = ?')) {
                  const [userId, version, roomId, sessionId] = args as [
                    string,
                    string,
                    string,
                    string,
                  ];
                  store.keys = store.keys.filter(
                    (k) =>
                      !(
                        k.user_id === userId &&
                        k.version === normalizeVersion(version) &&
                        k.room_id === roomId &&
                        k.session_id === sessionId
                      )
                  );
                } else if (sql.includes('room_id = ?')) {
                  const [userId, version, roomId] = args as [string, string, string];
                  store.keys = store.keys.filter(
                    (k) =>
                      !(
                        k.user_id === userId &&
                        k.version === normalizeVersion(version) &&
                        k.room_id === roomId
                      )
                  );
                } else {
                  const [userId, version] = args as [string, string];
                  store.keys = store.keys.filter(
                    (k) =>
                      !(k.user_id === userId && k.version === normalizeVersion(version))
                  );
                }
                return {
                  success: true,
                  meta: {
                    changes: before - store.keys.length,
                    last_row_id: 0,
                    duration: 0,
                    size_after: 0,
                  },
                  results: [],
                };
              }

              return {
                success: true,
                meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0 },
                results: [],
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: BackupStore };
}

function env(db: D1Database, partial: Partial<Env> = {}): Env {
  return {
    SERVER_NAME: 'example.com',
    DB: db,
    ...partial,
  } as Env;
}

function session(
  partial: Partial<KeyBackupData> = {}
): KeyBackupData {
  return {
    first_message_index: 0,
    forwarded_count: 0,
    is_verified: true,
    session_data: { ciphertext: 'abc', mac: 'def', ephemeral: 'ghi' },
    ...partial,
  };
}

async function request(
  method: string,
  path: string,
  db: D1Database,
  body?: unknown
) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await keyBackups.request(`http://localhost${path}`, init, env(db));
  let json: any = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, res };
}

function makeVersion(
  partial: Partial<VersionRow> & Pick<VersionRow, 'user_id' | 'version'>
): VersionRow {
  return {
    algorithm: MEGOLM,
    auth_data: JSON.stringify({ public_key: 'pk1' }),
    etag: 'etagseed01abcdef',
    count: 0,
    deleted: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('VALID_BACKUP_ALGORITHMS / isValidBackupAlgorithm', () => {
  it('lists exactly the two supported algorithms', () => {
    expect([...VALID_BACKUP_ALGORITHMS]).toEqual([MEGOLM, MSC3270]);
  });

  it('accepts megolm and msc3270', () => {
    expect(isValidBackupAlgorithm(MEGOLM)).toBe(true);
    expect(isValidBackupAlgorithm(MSC3270)).toBe(true);
  });

  it('rejects empty, unknown, and case-variant algorithms', () => {
    expect(isValidBackupAlgorithm('')).toBe(false);
    expect(isValidBackupAlgorithm('m.megolm.v1.aes-sha2')).toBe(false);
    expect(isValidBackupAlgorithm(MEGOLM.toUpperCase())).toBe(false);
    expect(isValidBackupAlgorithm(`${MEGOLM} `)).toBe(false);
    expect(isValidBackupAlgorithm(` ${MEGOLM}`)).toBe(false);
  });

  it('rejects near-miss MSC ids and partial prefixes', () => {
    expect(isValidBackupAlgorithm('org.matrix.msc3270')).toBe(false);
    expect(isValidBackupAlgorithm('m.megolm_backup.v1')).toBe(false);
    expect(isValidBackupAlgorithm('curve25519-aes-sha2')).toBe(false);
  });
});

describe('generateEtag', () => {
  it('returns a 16-char hex-ish opaque string without dashes', () => {
    const etag = generateEtag();
    expect(etag).toMatch(/^[0-9a-f]{16}$/);
    expect(etag).not.toContain('-');
  });

  it('returns distinct values across calls', () => {
    const set = new Set(Array.from({ length: 20 }, () => generateEtag()));
    expect(set.size).toBe(20);
  });
});

describe('formatBackupVersionResponse', () => {
  it('stringifies numeric version and parses auth_data JSON', () => {
    const row: KeyBackupVersionRow = {
      version: 7,
      algorithm: MEGOLM,
      auth_data: JSON.stringify({ public_key: 'BASE64PK', signatures: { '@u:s': { 'ed25519:1': 'sig' } } }),
      count: 3,
      etag: 'abcdef0123456789',
    };
    expect(formatBackupVersionResponse(row)).toEqual({
      algorithm: MEGOLM,
      auth_data: {
        public_key: 'BASE64PK',
        signatures: { '@u:s': { 'ed25519:1': 'sig' } },
      },
      count: 3,
      etag: 'abcdef0123456789',
      version: '7',
    });
  });

  it('preserves string version ids without double-wrapping', () => {
    expect(
      formatBackupVersionResponse({
        version: '42',
        algorithm: MSC3270,
        auth_data: '{}',
        count: 0,
        etag: 'x',
      }).version
    ).toBe('42');
  });

  it('throws when auth_data is not valid JSON', () => {
    expect(() =>
      formatBackupVersionResponse({
        version: 1,
        algorithm: MEGOLM,
        auth_data: '{broken',
        count: 0,
        etag: 'e',
      })
    ).toThrow();
  });

  it('allows empty object auth_data', () => {
    expect(
      formatBackupVersionResponse({
        version: 1,
        algorithm: MEGOLM,
        auth_data: '{}',
        count: 0,
        etag: 'e',
      }).auth_data
    ).toEqual({});
  });

  it('preserves count of zero and large counts', () => {
    expect(
      formatBackupVersionResponse({
        version: 1,
        algorithm: MEGOLM,
        auth_data: '{}',
        count: 0,
        etag: 'e',
      }).count
    ).toBe(0);
    expect(
      formatBackupVersionResponse({
        version: 1,
        algorithm: MEGOLM,
        auth_data: '{}',
        count: 1_000_000,
        etag: 'e',
      }).count
    ).toBe(1_000_000);
  });
});

describe('mapKeyRowToSession', () => {
  it('maps is_verified 1 → true and parses session_data', () => {
    const row: KeyBackupKeyRow = {
      session_id: 's1',
      first_message_index: 2,
      forwarded_count: 1,
      is_verified: 1,
      session_data: JSON.stringify({ ciphertext: 'c' }),
    };
    expect(mapKeyRowToSession(row)).toEqual({
      first_message_index: 2,
      forwarded_count: 1,
      is_verified: true,
      session_data: { ciphertext: 'c' },
    });
  });

  it('maps is_verified 0 → false', () => {
    expect(
      mapKeyRowToSession({
        session_id: 's',
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 0,
        session_data: '{}',
      }).is_verified
    ).toBe(false);
  });

  it('treats any non-1 integer as unverified (strict === 1)', () => {
    for (const flag of [2, -1, 10, NaN]) {
      expect(
        mapKeyRowToSession({
          session_id: 's',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: flag,
          session_data: '{}',
        }).is_verified
      ).toBe(false);
    }
  });

  it('throws on malformed session_data JSON', () => {
    expect(() =>
      mapKeyRowToSession({
        session_id: 's',
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 0,
        session_data: 'not-json',
      })
    ).toThrow();
  });

  it('preserves nested session_data structures', () => {
    const nested = { ciphertext: 'x', mac: 'y', ephemeral: 'z', nested: { a: [1, 2] } };
    expect(
      mapKeyRowToSession({
        session_id: 's',
        first_message_index: 9,
        forwarded_count: 3,
        is_verified: 1,
        session_data: JSON.stringify(nested),
      }).session_data
    ).toEqual(nested);
  });
});

describe('groupBackupKeysByRoom', () => {
  it('returns empty object for empty input', () => {
    expect(groupBackupKeysByRoom([])).toEqual({});
  });

  it('groups multiple sessions under one room', () => {
    const rooms = groupBackupKeysByRoom([
      {
        room_id: ROOM_A,
        session_id: 's1',
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 1,
        session_data: JSON.stringify({ a: 1 }),
      },
      {
        room_id: ROOM_A,
        session_id: 's2',
        first_message_index: 1,
        forwarded_count: 0,
        is_verified: 0,
        session_data: JSON.stringify({ a: 2 }),
      },
    ]);
    expect(Object.keys(rooms)).toEqual([ROOM_A]);
    expect(Object.keys(rooms[ROOM_A].sessions).sort()).toEqual(['s1', 's2']);
    expect(rooms[ROOM_A].sessions.s1.is_verified).toBe(true);
    expect(rooms[ROOM_A].sessions.s2.is_verified).toBe(false);
  });

  it('keeps separate rooms independent', () => {
    const rooms = groupBackupKeysByRoom([
      {
        room_id: ROOM_A,
        session_id: 's1',
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 1,
        session_data: '{}',
      },
      {
        room_id: ROOM_B,
        session_id: 's1',
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 0,
        session_data: '{}',
      },
    ]);
    expect(Object.keys(rooms).sort()).toEqual([ROOM_A, ROOM_B].sort());
    expect(rooms[ROOM_A].sessions.s1.is_verified).toBe(true);
    expect(rooms[ROOM_B].sessions.s1.is_verified).toBe(false);
  });

  it('later duplicate session_id in same room overwrites earlier', () => {
    const rooms = groupBackupKeysByRoom([
      {
        room_id: ROOM_A,
        session_id: 's1',
        first_message_index: 0,
        forwarded_count: 0,
        is_verified: 0,
        session_data: JSON.stringify({ v: 1 }),
      },
      {
        room_id: ROOM_A,
        session_id: 's1',
        first_message_index: 5,
        forwarded_count: 2,
        is_verified: 1,
        session_data: JSON.stringify({ v: 2 }),
      },
    ]);
    expect(rooms[ROOM_A].sessions.s1).toEqual({
      first_message_index: 5,
      forwarded_count: 2,
      is_verified: true,
      session_data: { v: 2 },
    });
  });
});

describe('verifiedFlag / sessionUpsertValues', () => {
  it('verifiedFlag maps truthy boolean only', () => {
    expect(verifiedFlag(true)).toBe(1);
    expect(verifiedFlag(false)).toBe(0);
    expect(verifiedFlag(undefined)).toBe(0);
    expect(verifiedFlag(null)).toBe(0);
  });

  it('sessionUpsertValues packs bind tuple in SQL column order', () => {
    const s = session({
      first_message_index: 4,
      forwarded_count: 2,
      is_verified: false,
      session_data: { ciphertext: 'zz' },
    });
    expect(sessionUpsertValues(AUTH_USER, '3', ROOM_A, 'sess1', s)).toEqual([
      AUTH_USER,
      '3',
      ROOM_A,
      'sess1',
      4,
      2,
      0,
      JSON.stringify({ ciphertext: 'zz' }),
    ]);
  });

  it('sessionUpsertValues sets verified flag 1 when is_verified true', () => {
    const values = sessionUpsertValues(AUTH_USER, '1', ROOM_A, 's', session({ is_verified: true }));
    expect(values[6]).toBe(1);
  });

  it('stringifies empty session_data object', () => {
    const values = sessionUpsertValues(
      AUTH_USER,
      '1',
      ROOM_A,
      's',
      session({ session_data: {} })
    );
    expect(values[7]).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// Route coverage — backup versions
// ---------------------------------------------------------------------------

describe('POST /room_keys/version', () => {
  it('creates a megolm backup and returns string version', async () => {
    const db = createBackupDb();
    const { status, body } = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
      auth_data: { public_key: 'pk' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ version: '1' });
    expect(db.store.versions).toHaveLength(1);
    expect(db.store.versions[0]).toMatchObject({
      user_id: AUTH_USER,
      algorithm: MEGOLM,
      count: 0,
      deleted: 0,
    });
    expect(db.store.versions[0].etag).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(db.store.versions[0].auth_data)).toEqual({ public_key: 'pk' });
  });

  it('accepts MSC3270 algorithm', async () => {
    const db = createBackupDb();
    const { status, body } = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MSC3270,
      auth_data: { public_key: 'pk2' },
    });
    expect(status).toBe(200);
    expect(body.version).toBe('1');
    expect(db.store.versions[0].algorithm).toBe(MSC3270);
  });

  it('rejects unknown algorithm with M_INVALID_PARAM listing both algos', async () => {
    const db = createBackupDb();
    const { status, body } = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: 'm.bad',
      auth_data: { public_key: 'pk' },
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
    expect(body.error).toContain(MEGOLM);
    expect(body.error).toContain(MSC3270);
    expect(db.store.versions).toHaveLength(0);
  });

  it('rejects missing algorithm / auth_data', async () => {
    const db = createBackupDb();
    const a = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
    });
    expect(a.status).toBe(400);
    expect(a.body.errcode).toBe('M_MISSING_PARAM');

    const b = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      auth_data: { public_key: 'pk' },
    });
    expect(b.status).toBe(400);
    expect(b.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects empty-string algorithm as missing', async () => {
    const db = createBackupDb();
    const { status, body } = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: '',
      auth_data: { public_key: 'pk' },
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects bad JSON body', async () => {
    const db = createBackupDb();
    const { status, body } = await request(
      'POST',
      '/_matrix/client/v3/room_keys/version',
      db,
      '{not-json'
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('increments version ids across creates', async () => {
    const db = createBackupDb();
    const first = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
      auth_data: { public_key: 'a' },
    });
    const second = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
      auth_data: { public_key: 'b' },
    });
    expect(first.body.version).toBe('1');
    expect(second.body.version).toBe('2');
    expect(db.store.versions).toHaveLength(2);
  });

  it('stores signatures inside auth_data when provided', async () => {
    const db = createBackupDb();
    const auth_data = {
      public_key: 'pk',
      signatures: { [AUTH_USER]: { 'ed25519:DEVICE1': 'sigbytes' } },
    };
    await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
      auth_data,
    });
    expect(JSON.parse(db.store.versions[0].auth_data)).toEqual(auth_data);
  });
});

describe('GET /room_keys/version and /version/:version', () => {
  it('returns 404 when no backup exists', async () => {
    const db = createBackupDb();
    const { status, body } = await request('GET', '/_matrix/client/v3/room_keys/version', db);
    expect(status).toBe(404);
    expect(body).toEqual({ errcode: 'M_NOT_FOUND', error: 'No backup found' });
  });

  it('returns latest non-deleted version for the auth user', async () => {
    const db = createBackupDb({
      versions: [
        makeVersion({ user_id: AUTH_USER, version: 1, etag: 'oldetag000000001', count: 1 }),
        makeVersion({
          user_id: AUTH_USER,
          version: 2,
          etag: 'newetag000000002',
          count: 5,
          auth_data: JSON.stringify({ public_key: 'latest' }),
        }),
        makeVersion({ user_id: OTHER_USER, version: 9, etag: 'other00000000009' }),
      ],
      nextVersion: 10,
    });
    const { status, body } = await request('GET', '/_matrix/client/v3/room_keys/version', db);
    expect(status).toBe(200);
    expect(body).toEqual({
      algorithm: MEGOLM,
      auth_data: { public_key: 'latest' },
      count: 5,
      etag: 'newetag000000002',
      version: '2',
    });
  });

  it('skips soft-deleted versions when resolving current', async () => {
    const db = createBackupDb({
      versions: [
        makeVersion({ user_id: AUTH_USER, version: 1, etag: 'keep000000000001' }),
        makeVersion({ user_id: AUTH_USER, version: 2, deleted: 1, etag: 'gone000000000002' }),
      ],
      nextVersion: 3,
    });
    const { body } = await request('GET', '/_matrix/client/v3/room_keys/version', db);
    expect(body.version).toBe('1');
    expect(body.etag).toBe('keep000000000001');
  });

  it('GET specific version returns that row', async () => {
    const db = createBackupDb({
      versions: [
        makeVersion({
          user_id: AUTH_USER,
          version: 3,
          algorithm: MSC3270,
          auth_data: JSON.stringify({ public_key: 'v3' }),
          count: 8,
          etag: 'etagv30000000003',
        }),
      ],
      nextVersion: 4,
    });
    const { status, body } = await request(
      'GET',
      '/_matrix/client/v3/room_keys/version/3',
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      algorithm: MSC3270,
      auth_data: { public_key: 'v3' },
      count: 8,
      etag: 'etagv30000000003',
      version: '3',
    });
  });

  it('GET specific version 404s for missing or deleted', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, deleted: 1 })],
      nextVersion: 2,
    });
    const missing = await request('GET', '/_matrix/client/v3/room_keys/version/99', db);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Backup version not found');

    const deleted = await request('GET', '/_matrix/client/v3/room_keys/version/1', db);
    expect(deleted.status).toBe(404);
  });

  it('does not return another user\'s version', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: OTHER_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status } = await request('GET', '/_matrix/client/v3/room_keys/version/1', db);
    expect(status).toBe(404);
  });
});

describe('PUT /room_keys/version/:version', () => {
  it('updates auth_data when provided', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      '/_matrix/client/v3/room_keys/version/1',
      db,
      { auth_data: { public_key: 'rotated' } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(JSON.parse(db.store.versions[0].auth_data)).toEqual({ public_key: 'rotated' });
  });

  it('no-ops auth_data update when field omitted', async () => {
    const db = createBackupDb({
      versions: [
        makeVersion({
          user_id: AUTH_USER,
          version: 1,
          auth_data: JSON.stringify({ public_key: 'keep' }),
        }),
      ],
      nextVersion: 2,
    });
    const { status } = await request('PUT', '/_matrix/client/v3/room_keys/version/1', db, {
      algorithm: MSC3270,
    });
    expect(status).toBe(200);
    expect(JSON.parse(db.store.versions[0].auth_data)).toEqual({ public_key: 'keep' });
    // algorithm field in body is ignored by current implementation
    expect(db.store.versions[0].algorithm).toBe(MEGOLM);
  });

  it('404s when version missing', async () => {
    const db = createBackupDb();
    const { status, body } = await request(
      'PUT',
      '/_matrix/client/v3/room_keys/version/1',
      db,
      { auth_data: { public_key: 'x' } }
    );
    expect(status).toBe(404);
    expect(body.error).toBe('Backup version not found');
  });

  it('rejects bad JSON', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      '/_matrix/client/v3/room_keys/version/1',
      db,
      '{bad'
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});

describe('DELETE /room_keys/version/:version', () => {
  it('soft-deletes version and hard-deletes its keys', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 2 })],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's2',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 0,
          session_data: '{}',
        },
        {
          user_id: AUTH_USER,
          version: '2',
          room_id: ROOM_A,
          session_id: 'keep',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 0,
          session_data: '{}',
        },
      ],
      nextVersion: 3,
    });
    const { status, body } = await request(
      'DELETE',
      '/_matrix/client/v3/room_keys/version/1',
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.store.versions[0].deleted).toBe(1);
    expect(db.store.keys.map((k) => k.session_id)).toEqual(['keep']);
  });

  it('404s when version already deleted or missing', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, deleted: 1 })],
      nextVersion: 2,
    });
    expect(
      (await request('DELETE', '/_matrix/client/v3/room_keys/version/1', db)).status
    ).toBe(404);
    expect(
      (await request('DELETE', '/_matrix/client/v3/room_keys/version/99', db)).status
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Route coverage — key upload / download / delete
// ---------------------------------------------------------------------------

describe('PUT /room_keys/keys (bulk / room / session)', () => {
  it('requires version query param', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const bulk = await request('PUT', '/_matrix/client/v3/room_keys/keys', db, {
      rooms: {},
    });
    expect(bulk.status).toBe(400);
    expect(bulk.body.errcode).toBe('M_MISSING_PARAM');

    const room = await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}`,
      db,
      { sessions: {} }
    );
    expect(room.status).toBe(400);

    const one = await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1`,
      db,
      session()
    );
    expect(one.status).toBe(400);
  });

  it('404s when backup version missing', async () => {
    const db = createBackupDb();
    const { status, body } = await request(
      'PUT',
      '/_matrix/client/v3/room_keys/keys?version=1',
      db,
      { rooms: { [ROOM_A]: { sessions: { s1: session() } } } }
    );
    expect(status).toBe(404);
    expect(body.error).toBe('Backup version not found');
  });

  it('bulk uploads multiple rooms/sessions and refreshes count+etag', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, etag: 'oldetag000000001' })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      '/_matrix/client/v3/room_keys/keys?version=1',
      db,
      {
        rooms: {
          [ROOM_A]: {
            sessions: {
              s1: session({ is_verified: true }),
              s2: session({ is_verified: false, first_message_index: 3 }),
            },
          },
          [ROOM_B]: {
            sessions: {
              s9: session({ forwarded_count: 2 }),
            },
          },
        },
      }
    );
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(body.etag).not.toBe('oldetag000000001');
    expect(db.store.keys).toHaveLength(3);
    expect(db.store.versions[0].count).toBe(3);
    expect(db.store.versions[0].etag).toBe(body.etag);

    const unverified = db.store.keys.find((k) => k.session_id === 's2');
    expect(unverified?.is_verified).toBe(0);
    expect(unverified?.first_message_index).toBe(3);
  });

  it('treats missing rooms object as empty upload (count stays 0)', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      '/_matrix/client/v3/room_keys/keys?version=1',
      db,
      {}
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(db.store.keys).toHaveLength(0);
  });

  it('upserts existing session on conflict', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 1 })],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 0,
          session_data: JSON.stringify({ v: 1 }),
        },
      ],
      nextVersion: 2,
    });
    await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db,
      session({
        first_message_index: 9,
        forwarded_count: 4,
        is_verified: true,
        session_data: { v: 2 },
      })
    );
    expect(db.store.keys).toHaveLength(1);
    expect(db.store.keys[0]).toMatchObject({
      first_message_index: 9,
      forwarded_count: 4,
      is_verified: 1,
      session_data: JSON.stringify({ v: 2 }),
    });
  });

  it('room-scoped PUT uploads only that room\'s sessions', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db,
      {
        sessions: {
          a: session(),
          b: session({ is_verified: false }),
        },
      }
    );
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(db.store.keys.every((k) => k.room_id === ROOM_A)).toBe(true);
  });

  it('decodes percent-encoded room ids on PUT', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db,
      session()
    );
    expect(db.store.keys[0].room_id).toBe(ROOM_A);
  });

  it('rejects bad JSON on bulk/room/session PUT', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    for (const path of [
      '/_matrix/client/v3/room_keys/keys?version=1',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
    ]) {
      const { status, body } = await request('PUT', path, db, '{nope');
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_BAD_JSON');
    }
  });

  it('handles empty sessions object on room PUT', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db,
      { sessions: {} }
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
  });

  it('handles missing sessions key on room PUT as empty', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db,
      {}
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
  });
});

describe('GET /room_keys/keys (bulk / room / session)', () => {
  let db: ReturnType<typeof createBackupDb>;

  beforeEach(() => {
    db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 3 })],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: JSON.stringify({ ciphertext: 'a1' }),
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's2',
          first_message_index: 1,
          forwarded_count: 1,
          is_verified: 0,
          session_data: JSON.stringify({ ciphertext: 'a2' }),
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_B,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: JSON.stringify({ ciphertext: 'b1' }),
        },
      ],
      nextVersion: 2,
    });
  });

  it('requires version query on all GET key routes', async () => {
    expect(
      (await request('GET', '/_matrix/client/v3/room_keys/keys', db)).body.errcode
    ).toBe('M_MISSING_PARAM');
    expect(
      (
        await request(
          'GET',
          `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}`,
          db
        )
      ).body.errcode
    ).toBe('M_MISSING_PARAM');
    expect(
      (
        await request(
          'GET',
          `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1`,
          db
        )
      ).body.errcode
    ).toBe('M_MISSING_PARAM');
  });

  it('404s when version missing', async () => {
    const empty = createBackupDb();
    const { status, body } = await request(
      'GET',
      '/_matrix/client/v3/room_keys/keys?version=1',
      empty
    );
    expect(status).toBe(404);
    expect(body.error).toBe('Backup version not found');
  });

  it('downloads all keys grouped by room', async () => {
    const { status, body } = await request(
      'GET',
      '/_matrix/client/v3/room_keys/keys?version=1',
      db
    );
    expect(status).toBe(200);
    expect(body.rooms[ROOM_A].sessions.s1).toEqual({
      first_message_index: 0,
      forwarded_count: 0,
      is_verified: true,
      session_data: { ciphertext: 'a1' },
    });
    expect(body.rooms[ROOM_A].sessions.s2.is_verified).toBe(false);
    expect(body.rooms[ROOM_B].sessions.s1.session_data).toEqual({ ciphertext: 'b1' });
  });

  it('downloads one room\'s sessions only', async () => {
    const { status, body } = await request(
      'GET',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db
    );
    expect(status).toBe(200);
    expect(Object.keys(body.sessions).sort()).toEqual(['s1', 's2']);
    expect(body.sessions.s2).toEqual({
      first_message_index: 1,
      forwarded_count: 1,
      is_verified: false,
      session_data: { ciphertext: 'a2' },
    });
  });

  it('returns empty sessions for a room with no keys', async () => {
    const { body } = await request(
      'GET',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent('!empty:example.com')}?version=1`,
      db
    );
    expect(body).toEqual({ sessions: {} });
  });

  it('downloads a single session key', async () => {
    const { status, body } = await request(
      'GET',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      first_message_index: 0,
      forwarded_count: 0,
      is_verified: true,
      session_data: { ciphertext: 'a1' },
    });
  });

  it('404s for unknown session', async () => {
    const { status, body } = await request(
      'GET',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/missing?version=1`,
      db
    );
    expect(status).toBe(404);
    expect(body).toEqual({ errcode: 'M_NOT_FOUND', error: 'Key not found' });
  });

  it('returns empty rooms object when version has no keys', async () => {
    const bare = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { body } = await request(
      'GET',
      '/_matrix/client/v3/room_keys/keys?version=1',
      bare
    );
    expect(body).toEqual({ rooms: {} });
  });
});

describe('DELETE /room_keys/keys (bulk / room / session)', () => {
  it('requires version query on all DELETE key routes', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    expect(
      (await request('DELETE', '/_matrix/client/v3/room_keys/keys', db)).body.errcode
    ).toBe('M_MISSING_PARAM');
    expect(
      (
        await request(
          'DELETE',
          `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}`,
          db
        )
      ).body.errcode
    ).toBe('M_MISSING_PARAM');
    expect(
      (
        await request(
          'DELETE',
          `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1`,
          db
        )
      ).body.errcode
    ).toBe('M_MISSING_PARAM');
  });

  it('deletes all keys for a version and zeros count', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 2, etag: 'old' })],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_B,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 0,
          session_data: '{}',
        },
      ],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'DELETE',
      '/_matrix/client/v3/room_keys/keys?version=1',
      db
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(db.store.keys).toHaveLength(0);
    expect(db.store.versions[0].count).toBe(0);
    expect(db.store.versions[0].etag).toBe(body.etag);
  });

  it('deletes one room\'s keys and recounts', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 3 })],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's2',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_B,
          session_id: 'keep',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 0,
          session_data: '{}',
        },
      ],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'DELETE',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(db.store.keys.map((k) => k.session_id)).toEqual(['keep']);
    expect(db.store.versions[0].count).toBe(1);
  });

  it('deletes a single session and recounts', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 2 })],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's1',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 's2',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
      ],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'DELETE',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(db.store.keys.map((k) => k.session_id)).toEqual(['s2']);
  });

  it('delete of missing session still returns recount (idempotent)', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, count: 0 })],
      nextVersion: 2,
    });
    const { status, body } = await request(
      'DELETE',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/nope?version=1`,
      db
    );
    expect(status).toBe(200);
    expect(body.count).toBe(0);
  });
});

describe('key-backups auth scoping edges', () => {
  it('uses mocked auth userId for inserts (not body/query)', async () => {
    const db = createBackupDb();
    await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
      auth_data: { public_key: 'pk' },
    });
    expect(db.store.versions[0].user_id).toBe(AUTH_USER);
  });

  it('does not leak other users\' keys in GET all', async () => {
    const db = createBackupDb({
      versions: [
        makeVersion({ user_id: AUTH_USER, version: 1 }),
        makeVersion({ user_id: OTHER_USER, version: 1 }),
      ],
      keys: [
        {
          user_id: OTHER_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 'secret',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: JSON.stringify({ ciphertext: 'nope' }),
        },
      ],
      nextVersion: 2,
    });
    const { body } = await request(
      'GET',
      '/_matrix/client/v3/room_keys/keys?version=1',
      db
    );
    expect(body).toEqual({ rooms: {} });
  });
});

describe('key-backups round-trip matrix', () => {
  it('create → upload → get → delete session → delete version', async () => {
    const db = createBackupDb();

    const created = await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MEGOLM,
      auth_data: { public_key: 'roundtrip' },
    });
    expect(created.body.version).toBe('1');

    const uploaded = await request(
      'PUT',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db,
      session({ session_data: { ciphertext: 'rt' } })
    );
    expect(uploaded.body.count).toBe(1);

    const got = await request(
      'GET',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db
    );
    expect(got.body.session_data).toEqual({ ciphertext: 'rt' });

    const delKey = await request(
      'DELETE',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}/s1?version=1`,
      db
    );
    expect(delKey.body.count).toBe(0);

    const delVer = await request('DELETE', '/_matrix/client/v3/room_keys/version/1', db);
    expect(delVer.status).toBe(200);
    expect(db.store.versions[0].deleted).toBe(1);

    const current = await request('GET', '/_matrix/client/v3/room_keys/version', db);
    expect(current.status).toBe(404);
  });

  it('create MSC3270 → bulk upload → room get → room delete → version get count 0', async () => {
    const db = createBackupDb();
    await request('POST', '/_matrix/client/v3/room_keys/version', db, {
      algorithm: MSC3270,
      auth_data: { public_key: 'msc' },
    });
    await request('PUT', '/_matrix/client/v3/room_keys/keys?version=1', db, {
      rooms: {
        [ROOM_A]: { sessions: { s1: session(), s2: session() } },
        [ROOM_B]: { sessions: { s1: session() } },
      },
    });
    const roomGet = await request(
      'GET',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db
    );
    expect(Object.keys(roomGet.body.sessions)).toHaveLength(2);

    const roomDel = await request(
      'DELETE',
      `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(ROOM_A)}?version=1`,
      db
    );
    expect(roomDel.body.count).toBe(1);

    const ver = await request('GET', '/_matrix/client/v3/room_keys/version/1', db);
    expect(ver.body.algorithm).toBe(MSC3270);
    expect(ver.body.count).toBe(1);
  });
});

describe('formatBackupVersionResponse auth_data edges', () => {
  it('preserves nullish nested signature values as parsed', () => {
    const auth = { public_key: 'pk', signatures: { '@u:s': { 'ed25519:1': '' } } };
    expect(
      formatBackupVersionResponse({
        version: 1,
        algorithm: MEGOLM,
        auth_data: JSON.stringify(auth),
        count: 0,
        etag: 'e',
      }).auth_data
    ).toEqual(auth);
  });

  it('accepts numeric version 0 stringified', () => {
    expect(
      formatBackupVersionResponse({
        version: 0,
        algorithm: MEGOLM,
        auth_data: '{}',
        count: 0,
        etag: 'e',
      }).version
    ).toBe('0');
  });
});

describe('isValidBackupAlgorithm exhaustive negatives', () => {
  it.each([
    'm.megolm_backup.v1.curve25519-aes-sha2x',
    'xm.megolm_backup.v1.curve25519-aes-sha2',
    'org.matrix.msc3270.v1.aes-hmac-sha2 ',
    'ORG.MATRIX.MSC3270.V1.AES-HMAC-SHA2',
    'null',
    'undefined',
    'm.megolm_backup.v1.curve25519-aes-sha2\n',
  ])('rejects %j', (algo) => {
    expect(isValidBackupAlgorithm(algo)).toBe(false);
  });
});

describe('generateEtag length invariant', () => {
  it('always returns exactly 16 characters even across many samples', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateEtag()).toHaveLength(16);
    }
  });
});

describe('groupBackupKeysByRoom large fan-out', () => {
  it('handles many rooms with one session each', () => {
    const keys = Array.from({ length: 25 }, (_, i) => ({
      room_id: `!r${i}:example.com`,
      session_id: 'only',
      first_message_index: i,
      forwarded_count: 0,
      is_verified: i % 2,
      session_data: JSON.stringify({ i }),
    }));
    const rooms = groupBackupKeysByRoom(keys);
    expect(Object.keys(rooms)).toHaveLength(25);
    expect(rooms['!r7:example.com'].sessions.only.first_message_index).toBe(7);
    expect(rooms['!r7:example.com'].sessions.only.is_verified).toBe(true);
    expect(rooms['!r8:example.com'].sessions.only.is_verified).toBe(false);
  });
});

describe('sessionUpsertValues edge values', () => {
  it('preserves zero indexes and large forwarded_count', () => {
    const values = sessionUpsertValues(
      AUTH_USER,
      '99',
      ROOM_B,
      'sess',
      session({ first_message_index: 0, forwarded_count: 999999, is_verified: false })
    );
    expect(values[4]).toBe(0);
    expect(values[5]).toBe(999999);
    expect(values[6]).toBe(0);
  });

  it('JSON-stringifies arrays and nested objects in session_data', () => {
    const data = { ciphertext: 'c', extras: [{ n: 1 }, { n: 2 }] };
    const values = sessionUpsertValues(
      AUTH_USER,
      '1',
      ROOM_A,
      's',
      session({ session_data: data })
    );
    expect(JSON.parse(values[7] as string)).toEqual(data);
  });
});

describe('PUT version auth_data with signatures round-trip via GET', () => {
  it('stores and returns rotated auth_data including signatures', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const auth_data = {
      public_key: 'newpk',
      signatures: { [AUTH_USER]: { 'ed25519:DEVICE1': 'sig2' } },
    };
    await request('PUT', '/_matrix/client/v3/room_keys/version/1', db, { auth_data });
    const { body } = await request('GET', '/_matrix/client/v3/room_keys/version/1', db);
    expect(body.auth_data).toEqual(auth_data);
  });
});

describe('bulk upload empty rooms map variants', () => {
  it('accepts rooms: {} and leaves count at 0 with fresh etag', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1, etag: 'staleetag0000001' })],
      nextVersion: 2,
    });
    const { body } = await request('PUT', '/_matrix/client/v3/room_keys/keys?version=1', db, {
      rooms: {},
    });
    expect(body.count).toBe(0);
    expect(body.etag).not.toBe('staleetag0000001');
    expect(db.store.versions[0].etag).toBe(body.etag);
  });

  it('room with empty sessions inside rooms map is a no-op for that room', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: AUTH_USER, version: 1 })],
      nextVersion: 2,
    });
    const { body } = await request('PUT', '/_matrix/client/v3/room_keys/keys?version=1', db, {
      rooms: { [ROOM_A]: { sessions: {} }, [ROOM_B]: { sessions: { s1: session() } } },
    });
    expect(body.count).toBe(1);
    expect(db.store.keys.map((k) => k.room_id)).toEqual([ROOM_B]);
  });
});

describe('DELETE version does not touch other users\' keys', () => {
  it('only deletes matching user_id+version keys', async () => {
    const db = createBackupDb({
      versions: [
        makeVersion({ user_id: AUTH_USER, version: 1 }),
        makeVersion({ user_id: OTHER_USER, version: 1 }),
      ],
      keys: [
        {
          user_id: AUTH_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 'mine',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
        {
          user_id: OTHER_USER,
          version: '1',
          room_id: ROOM_A,
          session_id: 'theirs',
          first_message_index: 0,
          forwarded_count: 0,
          is_verified: 1,
          session_data: '{}',
        },
      ],
      nextVersion: 2,
    });
    await request('DELETE', '/_matrix/client/v3/room_keys/version/1', db);
    expect(db.store.keys.map((k) => k.session_id)).toEqual(['theirs']);
    expect(db.store.versions.find((v) => v.user_id === OTHER_USER)?.deleted).toBe(0);
  });
});

describe('GET current version when only other-user backups exist', () => {
  it('returns No backup found', async () => {
    const db = createBackupDb({
      versions: [makeVersion({ user_id: OTHER_USER, version: 1 })],
      nextVersion: 2,
    });
    const { status, body } = await request('GET', '/_matrix/client/v3/room_keys/version', db);
    expect(status).toBe(404);
    expect(body.error).toBe('No backup found');
  });
});

describe('mapKeyRowToSession without session_id field', () => {
  it('does not require session_id on the input row', () => {
    expect(
      mapKeyRowToSession({
        first_message_index: 1,
        forwarded_count: 0,
        is_verified: 1,
        session_data: JSON.stringify({ ok: true }),
      })
    ).toEqual({
      first_message_index: 1,
      forwarded_count: 0,
      is_verified: true,
      session_data: { ok: true },
    });
  });
});
