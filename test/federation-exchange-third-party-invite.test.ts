/**
 * TOKENMAXX HEAVY deepen after #101/#103 — federation exchange_third_party_invite (email-fed 3PID).
 * Deep route coverage for PUT /_matrix/federation/v1/exchange_third_party_invite/:roomId
 * from src/api/federation.ts via Hono app.request().
 * Tests-only — fixtures use example.com only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/services/federation-keys', () => ({
  getRemoteKeysWithNotarySignature: vi.fn(),
  verifyRemoteSignature: vi.fn(),
}));

import federation from '../src/api/federation';
import {
  generateSigningKeyPair,
  signJson,
  verifySignature,
} from '../src/utils/crypto';

const ROOM = '!room:example.com';
const SERVER = 'example.com';
const IDENTITY_SERVER = 'identity.example.com';
const TOKEN = 's3cr3t-invite-token';
const MXID = '@bob:example.com';
const INVITER = '@inviter:example.com';

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

type SqlCall = { sql: string; args: unknown[] };

type StoredEvent = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  signatures: string;
};

type ThirdPartyInviteState = {
  event_id: string;
  content: string;
  sender: string;
  state_key: string;
};

type ExchangeDbOptions = {
  room?: { room_id: string; room_version: string } | null;
  thirdPartyInvite?: ThirdPartyInviteState | null;
  serverKey?: { key_id: string; private_key_jwk: string | null } | null;
  authEvents?: {
    create?: string;
    join_rules?: string;
    power_levels?: string;
    sender_membership?: string;
  };
  latestEvent?: { event_id: string; depth: number } | null;
  /** When true, INSERT OR IGNORE INTO events throws */
  failEventInsert?: boolean;
};

function createExchangeDb(opts: ExchangeDbOptions = {}) {
  const room =
    opts.room === undefined ? { room_id: ROOM, room_version: '10' } : opts.room;
  const thirdPartyInvite =
    opts.thirdPartyInvite === undefined
      ? ({
          event_id: '$3pid:example.com',
          content: JSON.stringify({ display_name: 'Bob', public_key: '' }),
          sender: INVITER,
          state_key: TOKEN,
        } satisfies ThirdPartyInviteState)
      : opts.thirdPartyInvite;
  const serverKey =
    opts.serverKey === undefined
      ? ({
          key_id: 'ed25519:server',
          private_key_jwk: '{}',
        } as { key_id: string; private_key_jwk: string | null })
      : opts.serverKey;
  const authEvents = opts.authEvents ?? {
    create: '$create:example.com',
    join_rules: '$join_rules:example.com',
    power_levels: '$power:example.com',
    sender_membership: '$inviter_member:example.com',
  };
  const latestEvent =
    opts.latestEvent === undefined
      ? { event_id: '$latest:example.com', depth: 42 }
      : opts.latestEvent;

  const events: StoredEvent[] = [];
  const roomState = new Map<string, { event_type: string; state_key: string; event_id: string }>();
  const memberships = new Map<string, { membership: string; event_id: string; display_name: string | null }>();
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const stateWrites: SqlCall[] = [];
  const membershipWrites: SqlCall[] = [];

  if (thirdPartyInvite) {
    roomState.set(`m.room.third_party_invite:${TOKEN}`, {
      event_type: 'm.room.third_party_invite',
      state_key: TOKEN,
      event_id: thirdPartyInvite.event_id,
    });
  }

  const db = {
    events,
    roomState,
    memberships,
    inserts,
    deletes,
    stateWrites,
    membershipWrites,
    prepare(sql: string) {
      async function firstWithArgs<T>(args: unknown[]): Promise<T | null> {
        if (sql.includes('SELECT room_id, room_version FROM rooms')) {
          return room as T;
        }

        if (
          sql.includes("rs.event_type = 'm.room.third_party_invite'") &&
          sql.includes('rs.state_key = ?')
        ) {
          const [roomId, token] = args as [string, string];
          if (roomId !== ROOM || !thirdPartyInvite || token !== thirdPartyInvite.state_key) {
            return null;
          }
          return thirdPartyInvite as T;
        }

        if (
          sql.includes('FROM server_keys') &&
          sql.includes('is_current = 1') &&
          sql.includes('key_version = 2')
        ) {
          return serverKey as T;
        }

        if (sql.includes("rs.event_type = 'm.room.create'")) {
          const [roomId] = args as [string];
          if (roomId !== ROOM || !authEvents.create) return null;
          return { event_id: authEvents.create } as T;
        }

        if (sql.includes("rs.event_type = 'm.room.join_rules'")) {
          const [roomId] = args as [string];
          if (roomId !== ROOM || !authEvents.join_rules) return null;
          return { event_id: authEvents.join_rules } as T;
        }

        if (sql.includes("rs.event_type = 'm.room.power_levels'")) {
          const [roomId] = args as [string];
          if (roomId !== ROOM || !authEvents.power_levels) return null;
          return { event_id: authEvents.power_levels } as T;
        }

        if (
          sql.includes("rs.event_type = 'm.room.member'") &&
          sql.includes('rs.state_key = ?') &&
          !sql.includes('INSERT')
        ) {
          const [roomId, stateKey] = args as [string, string];
          if (roomId !== ROOM || stateKey !== INVITER || !authEvents.sender_membership) {
            return null;
          }
          return { event_id: authEvents.sender_membership } as T;
        }

        if (sql.includes('ORDER BY depth DESC LIMIT 1')) {
          const [roomId] = args as [string];
          if (roomId !== ROOM) return null;
          return latestEvent as T;
        }

        return null;
      }

      const stmt = {
        async first<T>() {
          return firstWithArgs<T>([]);
        },
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              return { results: [] as T[] };
            },
            async first<T>() {
              return firstWithArgs<T>(args);
            },
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO events')) {
                inserts.push({ sql, args });
                if (opts.failEventInsert) {
                  throw new Error('simulated event insert failure');
                }
                const [
                  eventId,
                  roomId,
                  sender,
                  eventType,
                  stateKey,
                  content,
                  originServerTs,
                  depth,
                  authEventsJson,
                  prevEventsJson,
                  signaturesJson,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  string,
                  string,
                  string,
                ];
                events.push({
                  event_id: eventId,
                  room_id: roomId,
                  sender,
                  event_type: eventType,
                  state_key: stateKey,
                  content,
                  origin_server_ts: originServerTs,
                  depth,
                  auth_events: authEventsJson,
                  prev_events: prevEventsJson,
                  signatures: signaturesJson,
                });
              }

              if (
                sql.includes('INSERT OR REPLACE INTO room_state') &&
                sql.includes("'m.room.member'")
              ) {
                stateWrites.push({ sql, args });
                const [roomId, stateKey, eventId] = args as [string, string, string];
                roomState.set(`m.room.member:${stateKey}`, {
                  event_type: 'm.room.member',
                  state_key: stateKey,
                  event_id: eventId,
                });
                roomState.delete(`m.room.third_party_invite:${TOKEN}`);
              }

              if (sql.includes('INSERT OR REPLACE INTO room_memberships')) {
                membershipWrites.push({ sql, args });
                const [roomId, userId, eventId, displayName] = args as [
                  string,
                  string,
                  string,
                  string | null,
                ];
                memberships.set(`${roomId}:${userId}`, {
                  membership: 'invite',
                  event_id: eventId,
                  display_name: displayName,
                });
              }

              if (
                sql.includes('DELETE FROM room_state') &&
                sql.includes("'m.room.third_party_invite'")
              ) {
                deletes.push({ sql, args });
                const [roomId, token] = args as [string, string];
                if (roomId === ROOM && token === TOKEN) {
                  roomState.delete(`m.room.third_party_invite:${TOKEN}`);
                }
              }

              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
      return stmt;
    },
  };

  return db as unknown as D1Database & {
    events: StoredEvent[];
    roomState: Map<string, { event_type: string; state_key: string; event_id: string }>;
    memberships: Map<string, { membership: string; event_id: string; display_name: string | null }>;
    inserts: SqlCall[];
    deletes: SqlCall[];
    stateWrites: SqlCall[];
    membershipWrites: SqlCall[];
  };
}

function makeEnv(db: ReturnType<typeof createExchangeDb>): Env {
  return {
    SERVER_NAME: SERVER,
    DB: db,
  } as Env;
}

async function putExchange(
  body: unknown,
  env: Env,
  roomId: string = ROOM
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await federation.request(
    `http://localhost/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(roomId)}`,
    init,
    env
  );
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

type IdentityKeyPair = {
  keyId: string;
  privateKeyJwk: JsonWebKey;
  publicKey: string;
};

async function signThirdPartyInviteSignedBlock(
  mxid: string,
  sender: string,
  token: string,
  identity: IdentityKeyPair
): Promise<{ mxid: string; token: string; signatures: Record<string, Record<string, string>> }> {
  const signed = await signJson(
    { mxid, sender, token },
    IDENTITY_SERVER,
    identity.keyId,
    identity.privateKeyJwk
  );
  return {
    mxid,
    token,
    signatures: signed.signatures as Record<string, Record<string, string>>,
  };
}

function baseInviteBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'm.room.member',
    room_id: ROOM,
    sender: INVITER,
    state_key: MXID,
    content: {
      membership: 'invite',
      third_party_invite: {
        display_name: 'Bob',
        signed: {
          mxid: MXID,
          token: TOKEN,
          signatures: {},
        },
      },
    },
    ...overrides,
  };
}

describe('PUT /_matrix/federation/v1/exchange_third_party_invite/:roomId', () => {
  let restoreEd25519: (() => void) | undefined;
  let identityKeys: IdentityKeyPair;
  let serverKeys: IdentityKeyPair;

  beforeAll(async () => {
    restoreEd25519 = installNodeEd25519Shim();
    identityKeys = await generateSigningKeyPair();
    serverKeys = await generateSigningKeyPair();
  });

  afterAll(() => {
    restoreEd25519?.();
  });

  async function buildHappyEnv(inviteContent: Record<string, unknown>) {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const db = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: JSON.stringify(inviteContent),
        sender: INVITER,
        state_key: TOKEN,
      },
      serverKey: {
        key_id: serverKeys.keyId,
        private_key_jwk: JSON.stringify(serverKeys.privateKeyJwk),
      },
    });
    const body = baseInviteBody({
      content: {
        membership: 'invite',
        third_party_invite: {
          display_name: 'Bob',
          signed,
        },
      },
    });
    return { db, body, signed };
  }

  it('returns M_BAD_JSON for malformed request body', async () => {
    const db = createExchangeDb();
    const { status, body } = await putExchange('{not-json', makeEnv(db));
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_BAD_JSON',
      error: 'Could not parse request body as JSON',
    });
  });

  it('rejects when type is not m.room.member or membership is not invite', async () => {
    const db = createExchangeDb();
    const env = makeEnv(db);

    const wrongType = await putExchange(
      baseInviteBody({ type: 'm.room.message' }),
      env
    );
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Event must be a membership invite',
    });

    const wrongMembership = await putExchange(
      baseInviteBody({
        content: {
          membership: 'join',
          third_party_invite: { signed: { mxid: MXID, token: TOKEN, signatures: {} } },
        },
      }),
      env
    );
    expect(wrongMembership.status).toBe(400);
    expect(wrongMembership.body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Event must be a membership invite',
    });
  });

  it('rejects room_id mismatch against path roomId', async () => {
    const db = createExchangeDb();
    const { status, body } = await putExchange(
      baseInviteBody({ room_id: '!other:example.com' }),
      makeEnv(db)
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Room ID mismatch',
    });
  });

  it('rejects missing third_party_invite or signed data', async () => {
    const db = createExchangeDb();
    const env = makeEnv(db);

    const noThirdParty = await putExchange(
      baseInviteBody({ content: { membership: 'invite' } }),
      env
    );
    expect(noThirdParty.status).toBe(400);
    expect(noThirdParty.body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Missing third_party_invite or signed data',
    });

    const noSigned = await putExchange(
      baseInviteBody({
        content: {
          membership: 'invite',
          third_party_invite: { display_name: 'Bob' },
        },
      }),
      env
    );
    expect(noSigned.status).toBe(400);
    expect(noSigned.body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Missing third_party_invite or signed data',
    });
  });

  it('rejects incomplete signed block (missing mxid, token, or signatures)', async () => {
    const db = createExchangeDb();
    const env = makeEnv(db);

    for (const signed of [
      { token: TOKEN, signatures: {} },
      { mxid: MXID, signatures: {} },
      { mxid: MXID, token: TOKEN },
    ]) {
      const res = await putExchange(
        baseInviteBody({
          content: {
            membership: 'invite',
            third_party_invite: { signed },
          },
        }),
        env
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: 'Incomplete signed data in third_party_invite',
      });
    }
  });

  it('returns 404 when room does not exist', async () => {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const db = createExchangeDb({ room: null });
    const { status, body } = await putExchange(
      baseInviteBody({
        content: {
          membership: 'invite',
          third_party_invite: { signed },
        },
      }),
      makeEnv(db)
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'Room not found',
    });
  });

  it('returns M_FORBIDDEN when no third_party_invite state matches token', async () => {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const db = createExchangeDb({ thirdPartyInvite: null });
    const { status, body } = await putExchange(
      baseInviteBody({
        content: {
          membership: 'invite',
          third_party_invite: { signed },
        },
      }),
      makeEnv(db)
    );
    expect(status).toBe(403);
    expect(body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'No third party invite found with matching token',
    });
  });

  it('returns M_INVALID_PARAM when stored third_party_invite content is not JSON', async () => {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const db = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: 'not-json{{{',
        sender: INVITER,
        state_key: TOKEN,
      },
    });
    const { status, body } = await putExchange(
      baseInviteBody({
        content: {
          membership: 'invite',
          third_party_invite: { signed },
        },
      }),
      makeEnv(db)
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid third party invite content',
    });
  });

  it('returns M_FORBIDDEN when third_party_invite signature cannot be verified', async () => {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const wrongKey = await generateSigningKeyPair();
    const db = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: JSON.stringify({ public_key: wrongKey.publicKey }),
        sender: INVITER,
        state_key: TOKEN,
      },
    });
    const { status, body } = await putExchange(
      baseInviteBody({
        content: {
          membership: 'invite',
          third_party_invite: { signed },
        },
      }),
      makeEnv(db)
    );
    expect(status).toBe(403);
    expect(body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Could not verify third party invite signature',
    });
  });

  it('returns M_INVALID_PARAM when mxid does not match state_key after valid signature', async () => {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const db = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: JSON.stringify({ public_key: identityKeys.publicKey }),
        sender: INVITER,
        state_key: TOKEN,
      },
      serverKey: {
        key_id: serverKeys.keyId,
        private_key_jwk: JSON.stringify(serverKeys.privateKeyJwk),
      },
    });
    const { status, body } = await putExchange(
      baseInviteBody({
        state_key: '@other:example.com',
        content: {
          membership: 'invite',
          third_party_invite: { signed },
        },
      }),
      makeEnv(db)
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'mxid does not match state_key',
    });
  });

  it('returns 500 when server signing key is missing or private_key_jwk is null', async () => {
    const signed = await signThirdPartyInviteSignedBlock(MXID, INVITER, TOKEN, identityKeys);
    const inviteContent = { public_key: identityKeys.publicKey };
    const requestBody = baseInviteBody({
      content: {
        membership: 'invite',
        third_party_invite: { signed },
      },
    });

    const noKeyDb = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: JSON.stringify(inviteContent),
        sender: INVITER,
        state_key: TOKEN,
      },
      serverKey: null,
    });
    const noKey = await putExchange(requestBody, makeEnv(noKeyDb));
    expect(noKey.status).toBe(500);
    expect(noKey.body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'Server signing key not configured',
    });

    const nullJwkDb = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: JSON.stringify(inviteContent),
        sender: INVITER,
        state_key: TOKEN,
      },
      serverKey: { key_id: 'ed25519:dead', private_key_jwk: null },
    });
    const nullJwk = await putExchange(requestBody, makeEnv(nullJwkDb));
    expect(nullJwk.status).toBe(500);
    expect(nullJwk.body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'Server signing key not configured',
    });
  });

  it('happy path with public_key field: stores invite, deletes 3pid state, creates membership', async () => {
    const { db, body, signed } = await buildHappyEnv({
      display_name: 'Bob Email',
      public_key: identityKeys.publicKey,
    });

    const verificationPayload = {
      mxid: MXID,
      sender: INVITER,
      token: TOKEN,
      signatures: signed.signatures,
    };
    expect(
      await verifySignature(
        verificationPayload,
        IDENTITY_SERVER,
        identityKeys.keyId,
        identityKeys.publicKey
      )
    ).toBe(true);

    const { status, body: responseBody } = await putExchange(body, makeEnv(db));
    expect(status).toBe(200);
    expect(responseBody).toEqual({});

    expect(db.events).toHaveLength(1);
    const stored = db.events[0];
    expect(stored.room_id).toBe(ROOM);
    expect(stored.sender).toBe(INVITER);
    expect(stored.event_type).toBe('m.room.member');
    expect(stored.state_key).toBe(MXID);
    expect(stored.depth).toBe(43);
    expect(JSON.parse(stored.content)).toMatchObject({
      membership: 'invite',
      third_party_invite: {
        signed: { mxid: MXID, token: TOKEN },
      },
    });
    expect(JSON.parse(stored.auth_events)).toEqual([
      '$create:example.com',
      '$join_rules:example.com',
      '$power:example.com',
      '$inviter_member:example.com',
      '$3pid:example.com',
    ]);
    expect(JSON.parse(stored.prev_events)).toEqual(['$latest:example.com']);
    expect(JSON.parse(stored.signatures)).toHaveProperty(SERVER);

    expect(db.roomState.has(`m.room.third_party_invite:${TOKEN}`)).toBe(false);
    expect(db.roomState.get(`m.room.member:${MXID}`)?.event_id).toBe(stored.event_id);
    expect(db.memberships.get(`${ROOM}:${MXID}`)).toEqual({
      membership: 'invite',
      event_id: stored.event_id,
      display_name: 'Bob Email',
    });
    expect(db.deletes).toHaveLength(1);
    expect(db.deletes[0].sql).toContain('DELETE FROM room_state');
    expect(db.inserts).toHaveLength(1);
    expect(db.stateWrites).toHaveLength(1);
    expect(db.membershipWrites).toHaveLength(1);
  });

  it('happy path with public_keys array verifies against nested key entry', async () => {
    const decoy = await generateSigningKeyPair();
    const { db, body } = await buildHappyEnv({
      display_name: 'Bob Phone',
      public_keys: [
        { public_key: decoy.publicKey, key_validity_url: 'https://identity.example.com/validity/decoy' },
        { public_key: identityKeys.publicKey, key_validity_url: 'https://identity.example.com/validity/primary' },
      ],
    });

    const { status, body: responseBody } = await putExchange(body, makeEnv(db));
    expect(status).toBe(200);
    expect(responseBody).toEqual({});
    expect(db.events).toHaveLength(1);
    expect(db.roomState.has(`m.room.third_party_invite:${TOKEN}`)).toBe(false);
    expect(db.memberships.get(`${ROOM}:${MXID}`)?.display_name).toBe('Bob Phone');
  });

  it('returns 500 when persisting the exchanged invite fails', async () => {
    const { db, body } = await buildHappyEnv({ public_key: identityKeys.publicKey });
    const failingDb = createExchangeDb({
      thirdPartyInvite: {
        event_id: '$3pid:example.com',
        content: JSON.stringify({ public_key: identityKeys.publicKey }),
        sender: INVITER,
        state_key: TOKEN,
      },
      serverKey: {
        key_id: serverKeys.keyId,
        private_key_jwk: JSON.stringify(serverKeys.privateKeyJwk),
      },
      failEventInsert: true,
    });
    const { status, body: responseBody } = await putExchange(body, makeEnv(failingDb));
    expect(status).toBe(500);
    expect(responseBody).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'Failed to store invite event',
    });
    expect(failingDb.events).toHaveLength(0);
    expect(db.events).toHaveLength(0);
  });
});
