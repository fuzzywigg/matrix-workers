/**
 * TOKENMAXX HEAVY leftovers after #161 — federation keys/events API soft/edge/reliability.
 * Complements federation-keys-events-api-routes.test.ts and federation-api-route-leftovers.
 * Orthogonal to keys/media/appservice races, push leftovers, relations, account-data leftovers.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const getRemoteKeysWithNotarySignature = vi.fn(
  async (): Promise<unknown[]> => []
);

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return {
    ...actual,
    getRemoteKeysWithNotarySignature: (...args: unknown[]) =>
      getRemoteKeysWithNotarySignature(...(args as [])),
    verifyRemoteSignature: vi.fn(),
  };
});

import federation from '../src/api/federation';
import { generateSigningKeyPair } from '../src/utils/crypto';

const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const REMOTE_USER = '@carol:remote.example.org';
const DEVICE = 'DEVICEA';
const DEVICE_B = 'DEVICEB';
const ROOM = '!room:example.com';
const EVENT = '$event:example.com';
const NOW = 1_700_000_000_000;

/** Remap Cloudflare NODE-ED25519 → Node Ed25519 for unit tests. */
function installNodeEd25519Shim() {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);

  const mapAlg = (
    alg: AlgorithmIdentifier | EcKeyGenParams | EcKeyImportParams | EcdsaParams | unknown
  ): AlgorithmIdentifier => {
    if (typeof alg === 'string') {
      return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
    }
    if (alg && typeof alg === 'object' && (alg as { name?: string }).name === 'NODE-ED25519') {
      return 'Ed25519';
    }
    return alg as AlgorithmIdentifier;
  };

  subtle.generateKey = ((alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) =>
    origGenerateKey(mapAlg(alg), extractable, usages)) as typeof subtle.generateKey;
  subtle.importKey = ((
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    alg: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[]
  ) =>
    origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg), key, data)) as typeof subtle.sign;
  subtle.verify = ((
    alg: AlgorithmIdentifier,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ) => origVerify(mapAlg(alg), key, signature, data)) as typeof subtle.verify;

  return () => {
    subtle.generateKey = origGenerateKey;
    subtle.importKey = origImportKey;
    subtle.sign = origSign;
    subtle.verify = origVerify;
  };
}

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    data,
    puts,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

type DeviceKeyMap = Record<string, unknown>;
type CrossSigningStore = {
  master?: unknown;
  self_signing?: unknown;
  user_signing?: unknown;
};

function createUserKeysStub(opts: {
  deviceKeys?: Record<string, DeviceKeyMap>;
  crossSigning?: CrossSigningStore;
  failGet?: boolean;
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  const fetches: Array<{ url: string; method: string }> = [];

  return {
    fetches,
    deviceKeys,
    crossSigning,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      fetches.push({ url: req.url, method: req.method });
      if (opts.failGet && path.endsWith('/get')) {
        return new Response('boom', { status: 500 });
      }
      if (path === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) return Response.json(deviceKeys[deviceId] ?? null);
        return Response.json(deviceKeys);
      }
      if (path === '/cross-signing/get') {
        return Response.json(crossSigning);
      }
      return new Response('not found', { status: 404 });
    },
  };
}

type ServerKeyRow = {
  key_id: string;
  public_key: string;
  private_key?: string | null;
  private_key_jwk: string | null;
  key_version: number | null;
  valid_from: number;
  valid_until: number | null;
  is_current: number;
};

type EventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  hashes?: string | null;
  signatures?: string | null;
};

type OtkRow = {
  id: number;
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  claimed: number;
};

type FallbackRow = {
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  used: number;
};

type SigRow = {
  user_id: string;
  key_id: string;
  signer_user_id: string;
  signer_key_id: string;
  signature: string;
};

type SqlCall = { sql: string; args: unknown[] };

function createFedDb(opts: {
  serverKeys?: ServerKeyRow[];
  users?: string[];
  devices?: Array<{ user_id: string; device_id: string; display_name: string | null }>;
  events?: EventRow[];
  rooms?: string[];
  otks?: OtkRow[];
  fallbacks?: FallbackRow[];
  signatures?: SigRow[];
  keyChanges?: Array<{ user_id: string; stream_position: number }>;
  throwOn?: string;
} = {}) {
  const serverKeys = opts.serverKeys ? [...opts.serverKeys] : [];
  const users = new Set(opts.users ?? [USER]);
  const devices = opts.devices ?? [];
  const events = opts.events ?? [];
  const rooms = new Set(opts.rooms ?? [ROOM]);
  const otks = opts.otks ?? [];
  const fallbacks = opts.fallbacks ?? [];
  const signatures = opts.signatures ?? [];
  const keyChanges = opts.keyChanges ?? [];
  const updates: SqlCall[] = [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    serverKeys,
    users,
    devices,
    events,
    rooms,
    otks,
    fallbacks,
    signatures,
    keyChanges,
    updates,
    inserts,
    selects,
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });
          if (opts.throwOn && sql.includes(opts.throwOn)) {
            throw new Error(`forced throw: ${opts.throwOn}`);
          }

          if (sql.includes('FROM server_keys WHERE is_current = 1 AND key_version = 2')) {
            const hit = serverKeys.find((k) => k.is_current === 1 && k.key_version === 2);
            return (hit
              ? { key_id: hit.key_id, private_key_jwk: hit.private_key_jwk }
              : null) as T;
          }

          if (sql.includes('FROM server_keys WHERE key_id = ?')) {
            const keyId = args[0] as string;
            const hit = serverKeys.find((k) => k.key_id === keyId);
            if (!hit) return null as T;
            return {
              key_id: hit.key_id,
              public_key: hit.public_key,
              valid_from: hit.valid_from,
              valid_until: hit.valid_until,
            } as T;
          }

          if (sql.includes('FROM users WHERE user_id = ?')) {
            const uid = args[0] as string;
            return (users.has(uid) ? { user_id: uid } : null) as T;
          }

          if (sql.includes('FROM events WHERE event_id = ? AND room_id = ?')) {
            const [eventId, roomId] = args as string[];
            const hit = events.find((e) => e.event_id === eventId && e.room_id === roomId);
            return (hit
              ? { event_id: hit.event_id, auth_events: hit.auth_events }
              : null) as T;
          }

          if (sql.includes('FROM events WHERE event_id = ?')) {
            const eventId = args[0] as string;
            const hit = events.find((e) => e.event_id === eventId);
            return (hit ?? null) as T;
          }

          if (sql.includes('FROM rooms WHERE room_id = ?')) {
            const roomId = args[0] as string;
            return (rooms.has(roomId) ? { room_id: roomId } : null) as T;
          }

          if (
            sql.includes('FROM one_time_keys') &&
            sql.includes('claimed = 0') &&
            sql.includes('LIMIT 1')
          ) {
            const [userId, deviceId, algorithm] = args as string[];
            const hit = otks.find(
              (o) =>
                o.user_id === userId &&
                o.device_id === deviceId &&
                o.algorithm === algorithm &&
                o.claimed === 0
            );
            return (hit
              ? { id: hit.id, key_id: hit.key_id, key_data: hit.key_data }
              : null) as T;
          }

          if (sql.includes('FROM fallback_keys')) {
            const [userId, deviceId, algorithm] = args as string[];
            const hit = fallbacks.find(
              (f) =>
                f.user_id === userId &&
                f.device_id === deviceId &&
                f.algorithm === algorithm
            );
            return (hit
              ? { key_id: hit.key_id, key_data: hit.key_data, used: hit.used }
              : null) as T;
          }

          if (sql.includes('MAX(stream_position)') && sql.includes('device_key_changes')) {
            const userId = args[0] as string;
            const rows = keyChanges.filter((k) => k.user_id === userId);
            if (rows.length === 0) return { stream_id: null } as T;
            return {
              stream_id: Math.max(...rows.map((r) => r.stream_position)),
            } as T;
          }

          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
        },

        async all<T>() {
          selects.push({ sql, args });
          if (opts.throwOn && sql.includes(opts.throwOn)) {
            throw new Error(`forced throw: ${opts.throwOn}`);
          }

          if (
            sql.includes('FROM server_keys WHERE is_current = 1') &&
            sql.includes('ORDER BY key_version DESC')
          ) {
            const rows = serverKeys
              .filter((k) => k.is_current === 1)
              .sort((a, b) => (b.key_version ?? 0) - (a.key_version ?? 0));
            return { results: rows } as unknown as T;
          }

          if (
            sql.includes('FROM server_keys WHERE is_current = 1') &&
            sql.includes('valid_until') &&
            !sql.includes('ORDER BY')
          ) {
            const rows = serverKeys
              .filter((k) => k.is_current === 1)
              .map((k) => ({
                key_id: k.key_id,
                public_key: k.public_key,
                valid_until: k.valid_until,
              }));
            return { results: rows } as unknown as T;
          }

          if (sql.includes('FROM devices WHERE user_id = ?')) {
            const userId = args[0] as string;
            const rows = devices
              .filter((d) => d.user_id === userId)
              .map((d) => ({
                device_id: d.device_id,
                display_name: d.display_name,
              }));
            return { results: rows } as unknown as T;
          }

          if (sql.includes('FROM cross_signing_signatures')) {
            const [userId, keyId] = args as string[];
            const rows = signatures.filter(
              (s) => s.user_id === userId && s.key_id === keyId
            );
            return { results: rows } as unknown as T;
          }

          return { results: [] } as unknown as T;
        },

        async run() {
          if (sql.includes('UPDATE server_keys SET is_current = 0')) {
            updates.push({ sql, args });
            for (const k of serverKeys) k.is_current = 0;
            return { success: true, meta: { changes: serverKeys.length } };
          }
          if (sql.includes('INSERT INTO server_keys')) {
            inserts.push({ sql, args });
            const [
              keyId,
              publicKey,
              privateKey,
              privateKeyJwk,
              validFrom,
              validUntil,
            ] = args as [string, string, string, string, number, number];
            serverKeys.push({
              key_id: keyId,
              public_key: publicKey,
              private_key: privateKey,
              private_key_jwk: privateKeyJwk,
              key_version: 2,
              valid_from: validFrom,
              valid_until: validUntil,
              is_current: 1,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE one_time_keys SET claimed = 1')) {
            updates.push({ sql, args });
            if (sql.includes('WHERE id = ?')) {
              const [, id] = args as [number, number];
              const hit = otks.find((o) => o.id === id);
              if (hit) hit.claimed = 1;
            } else {
              const [, userId, deviceId, keyId] = args as [
                number,
                string,
                string,
                string,
              ];
              const hit = otks.find(
                (o) =>
                  o.user_id === userId &&
                  o.device_id === deviceId &&
                  o.key_id === keyId
              );
              if (hit) hit.claimed = 1;
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE fallback_keys SET used = 1')) {
            updates.push({ sql, args });
            const [userId, deviceId, algorithm] = args as string[];
            const hit = fallbacks.find(
              (f) =>
                f.user_id === userId &&
                f.device_id === deviceId &&
                f.algorithm === algorithm
            );
            if (hit) hit.used = 1;
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`Unhandled run() SQL: ${sql.slice(0, 160)}`);
        },
      });

      // D1 allows prepare().all()/first()/run() without bind when there are no params
      return {
        bind(...args: unknown[]) {
          return exec(args);
        },
        first: <T>() => exec([]).first<T>(),
        all: <T>() => exec([]).all<T>(),
        run: () => exec([]).run(),
      };
    },
  };

  return db as unknown as D1Database & typeof db;
}

function createEnv(opts: {
  db?: ReturnType<typeof createFedDb>;
  userKeys?: ReturnType<typeof createUserKeysStub>;
  oneTimeKeysKv?: ReturnType<typeof mockKv>;
  cacheKv?: ReturnType<typeof mockKv>;
  serverName?: string;
  serverVersion?: string;
} = {}): Env {
  const db = opts.db ?? createFedDb();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const oneTimeKeysKv = opts.oneTimeKeysKv ?? mockKv();
  const cacheKv = opts.cacheKv ?? mockKv();

  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: opts.serverName ?? SERVER,
    SERVER_VERSION: opts.serverVersion ?? '0.1.0-test',
    SESSIONS: mockKv() as unknown as KVNamespace,
    DEVICE_KEYS: mockKv() as unknown as KVNamespace,
    ONE_TIME_KEYS: oneTimeKeysKv as unknown as KVNamespace,
    CROSS_SIGNING_KEYS: mockKv() as unknown as KVNamespace,
    CACHE: cacheKv as unknown as KVNamespace,
    ACCOUNT_DATA: mockKv() as unknown as KVNamespace,
    MEDIA: {} as R2Bucket,
    USER_KEYS: {
      idFromName: (name: string) => ({ name }),
      get: () => userKeys,
    },
    FEDERATION: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    ROOM: { idFromName: () => ({}), get: () => ({}) },
    SYNC: { idFromName: () => ({}), get: () => ({}) },
    ADMIN: { idFromName: () => ({}), get: () => ({}) },
    PUSH: { idFromName: () => ({}), get: () => ({}) },
    RATE_LIMIT: { idFromName: () => ({}), get: () => ({}) },
    CALL_ROOM: { idFromName: () => ({}), get: () => ({}) },
  } as unknown as Env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; headers: Headers; text: string }> {
  const res = await federation.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function seedSecureKey(
  pair: { keyId: string; publicKey: string; privateKeyJwk: JsonWebKey },
  overrides: Partial<ServerKeyRow> = {}
): ServerKeyRow {
  return {
    key_id: pair.keyId,
    public_key: pair.publicKey,
    private_key: JSON.stringify(pair.privateKeyJwk),
    private_key_jwk: JSON.stringify(pair.privateKeyJwk),
    key_version: 2,
    valid_from: NOW - 1000,
    valid_until: NOW + 86_400_000,
    is_current: 1,
    ...overrides,
  };
}

function makeEvent(partial: Partial<EventRow> & Pick<EventRow, 'event_id'>): EventRow {
  return {
    event_id: partial.event_id,
    room_id: partial.room_id ?? ROOM,
    sender: partial.sender ?? USER,
    event_type: partial.event_type ?? 'm.room.message',
    state_key: partial.state_key !== undefined ? partial.state_key : null,
    content: partial.content ?? JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
    origin_server_ts: partial.origin_server_ts ?? NOW,
    depth: partial.depth ?? 3,
    auth_events: partial.auth_events ?? JSON.stringify([]),
    prev_events: partial.prev_events ?? JSON.stringify([]),
    hashes:
      partial.hashes !== undefined ? partial.hashes : JSON.stringify({ sha256: 'abc' }),
    signatures:
      partial.signatures !== undefined
        ? partial.signatures
        : JSON.stringify({ [SERVER]: { 'ed25519:1': 'sig' } }),
  };
}

function deviceKeysPayload(deviceId = DEVICE, userId = USER) {
  return {
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    device_id: deviceId,
    user_id: userId,
    keys: {
      [`ed25519:${deviceId}`]: 'edKey',
      [`curve25519:${deviceId}`]: 'cuKey',
    },
    signatures: {
      [userId]: { [`ed25519:${deviceId}`]: 'devsig' },
    },
  };
}

let restoreEd25519: (() => void) | undefined;
let securePair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

beforeAll(async () => {
  restoreEd25519 = installNodeEd25519Shim();
  securePair = await generateSigningKeyPair();
});

afterAll(() => {
  restoreEd25519?.();
});

beforeEach(() => {
  getRemoteKeysWithNotarySignature.mockReset();
  getRemoteKeysWithNotarySignature.mockResolvedValue([]);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});


// ---------------------------------------------------------------------------
// Federation version (unauthenticated)
// ---------------------------------------------------------------------------


void REMOTE;
void BOB;
void REMOTE_USER;
void DEVICE_B;
void EVENT;

describe('federation keys leftovers version soft flood after #161', () => {

  it('version soft-0', async () => {
    const env = createEnv({ serverVersion: 'soft-0.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-0.0.0' });
  });

  it('version soft-1', async () => {
    const env = createEnv({ serverVersion: 'soft-1.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-1.0.0' });
  });

  it('version soft-2', async () => {
    const env = createEnv({ serverVersion: 'soft-2.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-2.0.0' });
  });

  it('version soft-3', async () => {
    const env = createEnv({ serverVersion: 'soft-3.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-3.0.0' });
  });

  it('version soft-4', async () => {
    const env = createEnv({ serverVersion: 'soft-4.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-4.0.0' });
  });

  it('version soft-5', async () => {
    const env = createEnv({ serverVersion: 'soft-5.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-5.0.0' });
  });

  it('version soft-6', async () => {
    const env = createEnv({ serverVersion: 'soft-6.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-6.0.0' });
  });

  it('version soft-7', async () => {
    const env = createEnv({ serverVersion: 'soft-7.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-7.0.0' });
  });

  it('version soft-8', async () => {
    const env = createEnv({ serverVersion: 'soft-8.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-8.0.0' });
  });

  it('version soft-9', async () => {
    const env = createEnv({ serverVersion: 'soft-9.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-9.0.0' });
  });

  it('version soft-10', async () => {
    const env = createEnv({ serverVersion: 'soft-10.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-10.0.0' });
  });

  it('version soft-11', async () => {
    const env = createEnv({ serverVersion: 'soft-11.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-11.0.0' });
  });

  it('version soft-12', async () => {
    const env = createEnv({ serverVersion: 'soft-12.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-12.0.0' });
  });

  it('version soft-13', async () => {
    const env = createEnv({ serverVersion: 'soft-13.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-13.0.0' });
  });

  it('version soft-14', async () => {
    const env = createEnv({ serverVersion: 'soft-14.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-14.0.0' });
  });

  it('version soft-15', async () => {
    const env = createEnv({ serverVersion: 'soft-15.0.0' });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.server).toEqual({ name: 'matrix-worker', version: 'soft-15.0.0' });
  });
});

describe('federation keys leftovers key/v2/server soft flood after #161', () => {

  it('key/v2/server soft-0', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-1', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-2', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-3', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-4', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-5', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-6', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-7', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-8', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-9', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-10', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-11', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-12', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-13', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-14', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });

  it('key/v2/server soft-15', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
    expect(res.body.server_name).toBe(SERVER);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
    expect(res.body.signatures?.[SERVER]?.[securePair.keyId]).toBeTruthy();
  });
});

describe('federation keys leftovers key/v2/server/:keyId soft flood after #161', () => {

  it('keyId soft-0', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-1', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-2', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-3', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-4', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-5', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-6', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-7', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-8', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-9', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-10', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-11', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-12', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-13', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-14', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });

  it('keyId soft-15', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent(securePair.keyId)}`);
    expect(res.status).toBe(200);
    expect(res.body.verify_keys[securePair.keyId]).toEqual({ key: securePair.publicKey });
  });
});

describe('federation keys leftovers unknown keyId soft flood after #161', () => {

  it('unknown keyId soft-0', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing0')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-1', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing1')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-2', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing2')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-3', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing3')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-4', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing4')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-5', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing5')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-6', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing6')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-7', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing7')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-8', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing8')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-9', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing9')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-10', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing10')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-11', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing11')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-12', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing12')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-13', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing13')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-14', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing14')}`);
    expect(res.status).toBe(404);
  });

  it('unknown keyId soft-15', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, `/_matrix/key/v2/server/${encodeURIComponent('ed25519:missing15')}`);
    expect(res.status).toBe(404);
  });
});

describe('federation keys leftovers key/v2/query soft flood after #161', () => {

  it('query own soft-0', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-1', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-2', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-3', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-4', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-5', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-6', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-7', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-8', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-9', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-10', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-11', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-12', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-13', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-14', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });

  it('query own soft-15', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/key/v2/query',
      jsonInit('POST', { server_keys: { [SERVER]: { '': {} } } })
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.server_keys)).toBe(true);
    expect(res.body.server_keys.length).toBeGreaterThan(0);
  });
});

describe('federation keys leftovers GET key/v2/query/:serverName soft flood after #161', () => {

  it('query serverName soft-0', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-1', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-2', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-3', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-4', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-5', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-6', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-7', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-8', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-9', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-10', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-11', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-12', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-13', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-14', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });

  it('query serverName soft-15', async () => {
    const db = createFedDb({ serverKeys: [seedSecureKey(securePair)] });
    const env = createEnv({ db });
    const res = await request(env, `/_matrix/key/v2/query/${encodeURIComponent(SERVER)}`);
    expect(res.status).toBe(200);
  });
});

describe('federation keys leftovers user/keys/query soft flood after #161', () => {

  it('user keys query soft-0', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-1', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-2', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-3', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-4', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-5', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-6', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-7', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-8', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-9', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-10', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-11', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-12', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-13', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-14', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('user keys query soft-15', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[USER][DEVICE]).toBeTruthy();
  });
});

describe('federation keys leftovers user/keys/claim soft flood after #161', () => {

  it('claim OTK soft-0', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:0', keyData: { key: 'k0' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 1,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:0',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:0': { key: 'k0' },
    });
  });

  it('claim OTK soft-1', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:1', keyData: { key: 'k1' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 2,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:1',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:1': { key: 'k1' },
    });
  });

  it('claim OTK soft-2', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:2', keyData: { key: 'k2' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 3,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:2',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:2': { key: 'k2' },
    });
  });

  it('claim OTK soft-3', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:3', keyData: { key: 'k3' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 4,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:3',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:3': { key: 'k3' },
    });
  });

  it('claim OTK soft-4', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:4', keyData: { key: 'k4' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 5,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:4',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:4': { key: 'k4' },
    });
  });

  it('claim OTK soft-5', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:5', keyData: { key: 'k5' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 6,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:5',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:5': { key: 'k5' },
    });
  });

  it('claim OTK soft-6', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:6', keyData: { key: 'k6' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 7,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:6',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:6': { key: 'k6' },
    });
  });

  it('claim OTK soft-7', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:7', keyData: { key: 'k7' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 8,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:7',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:7': { key: 'k7' },
    });
  });

  it('claim OTK soft-8', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:8', keyData: { key: 'k8' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 9,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:8',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:8': { key: 'k8' },
    });
  });

  it('claim OTK soft-9', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:9', keyData: { key: 'k9' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 10,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:9',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:9': { key: 'k9' },
    });
  });

  it('claim OTK soft-10', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:10', keyData: { key: 'k10' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 11,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:10',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:10': { key: 'k10' },
    });
  });

  it('claim OTK soft-11', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:11', keyData: { key: 'k11' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 12,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:11',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:11': { key: 'k11' },
    });
  });

  it('claim OTK soft-12', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:12', keyData: { key: 'k12' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 13,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:12',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:12': { key: 'k12' },
    });
  });

  it('claim OTK soft-13', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:13', keyData: { key: 'k13' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 14,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:13',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:13': { key: 'k13' },
    });
  });

  it('claim OTK soft-14', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:14', keyData: { key: 'k14' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 15,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:14',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:14': { key: 'k14' },
    });
  });

  it('claim OTK soft-15', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:15', keyData: { key: 'k15' }, claimed: false },
        ],
      }),
    });
    const db = createFedDb({
      otks: [
        {
          id: 16,
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:15',
          key_data: '{}',
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/federation/v1/user/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.one_time_keys[USER][DEVICE]).toEqual({
      'signed_curve25519:15': { key: 'k15' },
    });
  });
});

describe('federation keys leftovers user/devices soft flood after #161', () => {

  it('devices soft-0', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-0' }],
      keyChanges: [{ user_id: USER, stream_position: 1 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(1);
    expect(res.body.devices[0].device_display_name).toBe('Phone-0');
  });

  it('devices soft-1', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-1' }],
      keyChanges: [{ user_id: USER, stream_position: 2 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(2);
    expect(res.body.devices[0].device_display_name).toBe('Phone-1');
  });

  it('devices soft-2', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-2' }],
      keyChanges: [{ user_id: USER, stream_position: 3 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(3);
    expect(res.body.devices[0].device_display_name).toBe('Phone-2');
  });

  it('devices soft-3', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-3' }],
      keyChanges: [{ user_id: USER, stream_position: 4 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(4);
    expect(res.body.devices[0].device_display_name).toBe('Phone-3');
  });

  it('devices soft-4', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-4' }],
      keyChanges: [{ user_id: USER, stream_position: 5 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(5);
    expect(res.body.devices[0].device_display_name).toBe('Phone-4');
  });

  it('devices soft-5', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-5' }],
      keyChanges: [{ user_id: USER, stream_position: 6 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(6);
    expect(res.body.devices[0].device_display_name).toBe('Phone-5');
  });

  it('devices soft-6', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-6' }],
      keyChanges: [{ user_id: USER, stream_position: 7 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(7);
    expect(res.body.devices[0].device_display_name).toBe('Phone-6');
  });

  it('devices soft-7', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-7' }],
      keyChanges: [{ user_id: USER, stream_position: 8 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(8);
    expect(res.body.devices[0].device_display_name).toBe('Phone-7');
  });

  it('devices soft-8', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-8' }],
      keyChanges: [{ user_id: USER, stream_position: 9 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(9);
    expect(res.body.devices[0].device_display_name).toBe('Phone-8');
  });

  it('devices soft-9', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-9' }],
      keyChanges: [{ user_id: USER, stream_position: 10 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(10);
    expect(res.body.devices[0].device_display_name).toBe('Phone-9');
  });

  it('devices soft-10', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-10' }],
      keyChanges: [{ user_id: USER, stream_position: 11 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(11);
    expect(res.body.devices[0].device_display_name).toBe('Phone-10');
  });

  it('devices soft-11', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-11' }],
      keyChanges: [{ user_id: USER, stream_position: 12 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(12);
    expect(res.body.devices[0].device_display_name).toBe('Phone-11');
  });

  it('devices soft-12', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-12' }],
      keyChanges: [{ user_id: USER, stream_position: 13 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(13);
    expect(res.body.devices[0].device_display_name).toBe('Phone-12');
  });

  it('devices soft-13', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-13' }],
      keyChanges: [{ user_id: USER, stream_position: 14 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(14);
    expect(res.body.devices[0].device_display_name).toBe('Phone-13');
  });

  it('devices soft-14', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-14' }],
      keyChanges: [{ user_id: USER, stream_position: 15 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(15);
    expect(res.body.devices[0].device_display_name).toBe('Phone-14');
  });

  it('devices soft-15', async () => {
    const db = createFedDb({
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'Phone-15' }],
      keyChanges: [{ user_id: USER, stream_position: 16 }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.stream_id).toBe(16);
    expect(res.body.devices[0].device_display_name).toBe('Phone-15');
  });
});

describe('federation keys leftovers event soft flood after #161', () => {

  it('event soft-0', async () => {
    const id = `$evt0:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-0', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-0');
  });

  it('event soft-1', async () => {
    const id = `$evt1:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-1', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-1');
  });

  it('event soft-2', async () => {
    const id = `$evt2:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-2', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-2');
  });

  it('event soft-3', async () => {
    const id = `$evt3:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-3', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-3');
  });

  it('event soft-4', async () => {
    const id = `$evt4:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-4', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-4');
  });

  it('event soft-5', async () => {
    const id = `$evt5:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-5', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-5');
  });

  it('event soft-6', async () => {
    const id = `$evt6:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-6', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-6');
  });

  it('event soft-7', async () => {
    const id = `$evt7:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-7', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-7');
  });

  it('event soft-8', async () => {
    const id = `$evt8:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-8', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-8');
  });

  it('event soft-9', async () => {
    const id = `$evt9:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-9', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-9');
  });

  it('event soft-10', async () => {
    const id = `$evt10:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-10', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-10');
  });

  it('event soft-11', async () => {
    const id = `$evt11:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-11', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-11');
  });

  it('event soft-12', async () => {
    const id = `$evt12:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-12', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-12');
  });

  it('event soft-13', async () => {
    const id = `$evt13:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-13', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-13');
  });

  it('event soft-14', async () => {
    const id = `$evt14:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-14', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-14');
  });

  it('event soft-15', async () => {
    const id = `$evt15:example.com`;
    const env = createEnv({
      db: createFedDb({ events: [makeEvent({ event_id: id, content: JSON.stringify({ body: 'soft-15', msgtype: 'm.text' }) })] }),
    });
    const res = await request(env, `/_matrix/federation/v1/event/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(res.body.pdus[0].event_id).toBe(id);
    expect(res.body.pdus[0].content.body).toBe('soft-15');
  });
});

describe('federation keys leftovers event_auth soft flood after #161', () => {

  it('event_auth soft-0', async () => {
    const auth = makeEvent({
      event_id: `$auth0`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf0`,
      auth_events: JSON.stringify([`$auth0`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf0`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth0`);
  });

  it('event_auth soft-1', async () => {
    const auth = makeEvent({
      event_id: `$auth1`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf1`,
      auth_events: JSON.stringify([`$auth1`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf1`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth1`);
  });

  it('event_auth soft-2', async () => {
    const auth = makeEvent({
      event_id: `$auth2`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf2`,
      auth_events: JSON.stringify([`$auth2`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf2`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth2`);
  });

  it('event_auth soft-3', async () => {
    const auth = makeEvent({
      event_id: `$auth3`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf3`,
      auth_events: JSON.stringify([`$auth3`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf3`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth3`);
  });

  it('event_auth soft-4', async () => {
    const auth = makeEvent({
      event_id: `$auth4`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf4`,
      auth_events: JSON.stringify([`$auth4`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf4`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth4`);
  });

  it('event_auth soft-5', async () => {
    const auth = makeEvent({
      event_id: `$auth5`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf5`,
      auth_events: JSON.stringify([`$auth5`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf5`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth5`);
  });

  it('event_auth soft-6', async () => {
    const auth = makeEvent({
      event_id: `$auth6`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf6`,
      auth_events: JSON.stringify([`$auth6`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf6`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth6`);
  });

  it('event_auth soft-7', async () => {
    const auth = makeEvent({
      event_id: `$auth7`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf7`,
      auth_events: JSON.stringify([`$auth7`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf7`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth7`);
  });

  it('event_auth soft-8', async () => {
    const auth = makeEvent({
      event_id: `$auth8`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf8`,
      auth_events: JSON.stringify([`$auth8`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf8`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth8`);
  });

  it('event_auth soft-9', async () => {
    const auth = makeEvent({
      event_id: `$auth9`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf9`,
      auth_events: JSON.stringify([`$auth9`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf9`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth9`);
  });

  it('event_auth soft-10', async () => {
    const auth = makeEvent({
      event_id: `$auth10`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf10`,
      auth_events: JSON.stringify([`$auth10`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf10`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth10`);
  });

  it('event_auth soft-11', async () => {
    const auth = makeEvent({
      event_id: `$auth11`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf11`,
      auth_events: JSON.stringify([`$auth11`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf11`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth11`);
  });

  it('event_auth soft-12', async () => {
    const auth = makeEvent({
      event_id: `$auth12`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf12`,
      auth_events: JSON.stringify([`$auth12`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf12`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth12`);
  });

  it('event_auth soft-13', async () => {
    const auth = makeEvent({
      event_id: `$auth13`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf13`,
      auth_events: JSON.stringify([`$auth13`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf13`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth13`);
  });

  it('event_auth soft-14', async () => {
    const auth = makeEvent({
      event_id: `$auth14`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf14`,
      auth_events: JSON.stringify([`$auth14`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf14`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth14`);
  });

  it('event_auth soft-15', async () => {
    const auth = makeEvent({
      event_id: `$auth15`,
      event_type: 'm.room.create',
      state_key: '',
      auth_events: '[]',
      depth: 1,
    });
    const leaf = makeEvent({
      event_id: `$leaf15`,
      auth_events: JSON.stringify([`$auth15`]),
      depth: 2,
    });
    const env = createEnv({
      db: createFedDb({ rooms: [ROOM], events: [auth, leaf] }),
    });
    const res = await request(
      env,
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$leaf15`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.auth_chain.map((e: { event_id: string }) => e.event_id)).toContain(`$auth15`);
  });
});

describe('federation keys leftovers failure edges after #161', () => {

  it('keys query bad JSON soft-0', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-0',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-1', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-2', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-2',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-3', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-3',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-4', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-4',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-5', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-5',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-6', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-6',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-7', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-7',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-8', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-8',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-9', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-9',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-10', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-10',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-11', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-11',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-12', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-12',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-13', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-13',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-14', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-14',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('keys query bad JSON soft-15', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-15',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
});

describe('federation keys leftovers charset soft flood after #161', () => {

  it('charset query soft-0', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-1', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-2', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-3', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-4', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-5', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-6', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-7', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-8', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-9', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-10', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-11', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-12', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-13', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-14', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });

  it('charset query soft-15', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ userKeys });
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ device_keys: { [USER]: [] } }),
    });
    expect(res.status).toBe(200);
  });
});

describe('federation keys leftovers method matrix after #161', () => {

  it('method ok GET soft-0', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
  });

  it('method ok GET soft-1', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
  });

  it('method ok POST soft-2', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', jsonInit('POST', { device_keys: { [USER]: [] } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok POST soft-3', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/claim', jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok GET soft-4', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
  });

  it('method ok GET soft-5', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
  });

  it('method ok POST soft-6', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', jsonInit('POST', { device_keys: { [USER]: [] } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok POST soft-7', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/claim', jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok GET soft-8', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
  });

  it('method ok GET soft-9', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
  });

  it('method ok POST soft-10', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', jsonInit('POST', { device_keys: { [USER]: [] } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok POST soft-11', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/claim', jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok GET soft-12', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/federation/v1/version');
    expect(res.status).toBe(200);
  });

  it('method ok GET soft-13', async () => {
    const env = createEnv({ db: createFedDb({ serverKeys: [seedSecureKey(securePair)] }) });
    const res = await request(env, '/_matrix/key/v2/server');
    expect(res.status).toBe(200);
  });

  it('method ok POST soft-14', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/query', jsonInit('POST', { device_keys: { [USER]: [] } }));
    expect([200, 400]).toContain(res.status);
  });

  it('method ok POST soft-15', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/federation/v1/user/keys/claim', jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } } }));
    expect([200, 400]).toContain(res.status);
  });
});

describe('federation keys leftovers lifecycle after #161', () => {

  it('version→keys→devices lifecycle soft-0', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L0' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L0');
  });

  it('version→keys→devices lifecycle soft-1', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L1' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L1');
  });

  it('version→keys→devices lifecycle soft-2', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L2' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L2');
  });

  it('version→keys→devices lifecycle soft-3', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L3' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L3');
  });

  it('version→keys→devices lifecycle soft-4', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L4' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L4');
  });

  it('version→keys→devices lifecycle soft-5', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L5' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L5');
  });

  it('version→keys→devices lifecycle soft-6', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L6' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L6');
  });

  it('version→keys→devices lifecycle soft-7', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L7' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L7');
  });

  it('version→keys→devices lifecycle soft-8', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L8' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L8');
  });

  it('version→keys→devices lifecycle soft-9', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L9' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L9');
  });

  it('version→keys→devices lifecycle soft-10', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L10' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L10');
  });

  it('version→keys→devices lifecycle soft-11', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L11' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L11');
  });

  it('version→keys→devices lifecycle soft-12', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L12' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L12');
  });

  it('version→keys→devices lifecycle soft-13', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L13' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L13');
  });

  it('version→keys→devices lifecycle soft-14', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L14' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L14');
  });

  it('version→keys→devices lifecycle soft-15', async () => {
    const db = createFedDb({
      serverKeys: [seedSecureKey(securePair)],
      users: [USER],
      devices: [{ user_id: USER, device_id: DEVICE, display_name: 'L15' }],
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE]: deviceKeysPayload(DEVICE) },
    });
    const env = createEnv({ db, userKeys });
    const v = await request(env, '/_matrix/federation/v1/version');
    expect(v.status).toBe(200);
    const k = await request(env, '/_matrix/key/v2/server');
    expect(k.status).toBe(200);
    const d = await request(env, `/_matrix/federation/v1/user/devices/${encodeURIComponent(USER)}`);
    expect(d.status).toBe(200);
    expect(d.body.devices[0].device_display_name).toBe('L15');
  });
});

describe('federation keys leftovers remote user forbid soft flood after #161', () => {

  it('remote devices forbid soft-0', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote0:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-1', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote1:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-2', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote2:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-3', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote3:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-4', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote4:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-5', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote5:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-6', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote6:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-7', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote7:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-8', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote8:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-9', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote9:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-10', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote10:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-11', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote11:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-12', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote12:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-13', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote13:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-14', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote14:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('remote devices forbid soft-15', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(`@remote15:remote.example.org`)}`
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('federation keys leftovers event missing soft flood after #161', () => {

  it('event missing soft-0', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing0:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-1', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing1:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-2', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing2:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-3', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing3:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-4', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing4:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-5', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing5:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-6', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing6:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-7', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing7:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-8', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing8:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-9', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing9:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-10', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing10:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-11', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing11:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-12', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing12:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-13', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing13:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-14', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing14:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('event missing soft-15', async () => {
    const env = createEnv({ db: createFedDb({ events: [] }) });
    const res = await request(
      env,
      `/_matrix/federation/v1/event/${encodeURIComponent(`$missing15:example.com`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
});

