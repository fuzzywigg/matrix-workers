/**
 * TOKENMAXX HEAVY leftovers after #317 — senary *federation* soft+concurrent-race
 * niches unsaturated by quinary membership/keys/query exact (#317).
 * Skip FederationCatchupWorkflow.
 *
 * Distinct from quinary (#317):
 *   user/keys/query exact Missing required parameter: device_keys;
 *   user/keys/claim exact Missing required parameter: one_time_keys;
 *   exchange_third_party_invite exact Event must be a membership invite /
 *     Room ID mismatch / Missing third_party_invite or signed data /
 *     Incomplete signed data in third_party_invite under soft+race;
 *   openid missing∥expired∥invalid triple under one Promise.all
 *     (quinary only missing access_token soft).
 *
 * Distinct from #315–#319 oauth/media/filters siblings. Tests-only. example.com only.
 * No product inventing. Reversible by deleting this file.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { generateSigningKeyPair } from '../src/utils/crypto';

const FED_ORIGIN = 'remote.example.com';
let federationOrigin: string | undefined = FED_ORIGIN;

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

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOrigin !== undefined) {
        c.set('federationOrigin', federationOrigin);
      }
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOrigin !== undefined) {
        c.set('federationOrigin', federationOrigin);
      }
      await next();
    };
  },
}));

const getRemoteKeysWithNotarySignature = vi.fn();
const verifyRemoteSignature = vi.fn();

vi.mock('../src/services/federation-keys', () => ({
  getRemoteKeysWithNotarySignature: (...args: unknown[]) =>
    getRemoteKeysWithNotarySignature(...args),
  verifyRemoteSignature: (...args: unknown[]) => verifyRemoteSignature(...args),
}));

const getRoomState = vi.fn(async () => ({}));
vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getRoomState: (...args: unknown[]) => getRoomState(...args),
  };
});

const checkEventAuth = vi.fn(() => ({ allowed: true }));
vi.mock('../src/services/event-auth', () => ({
  checkEventAuth: (...args: unknown[]) => checkEventAuth(...args),
}));

const verifyContentHash = vi.hoisted(() => vi.fn());
vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  verifyContentHash.mockImplementation(
    (content: Record<string, unknown>, expectedHash: string) =>
      actual.verifyContentHash(content, expectedHash)
  );
  return {
    ...actual,
    verifyContentHash: (...args: unknown[]) =>
      verifyContentHash(...(args as [Record<string, unknown>, string])),
  };
});

import federation from '../src/api/federation';

type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type KvBarrier = { match: (key: string) => boolean; count: number };
type R2Barrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: { match: (...a: unknown[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...matchArgs: unknown[]
) {
  if (!barrier || !barrier.match(...matchArgs)) return;
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


const SERVER = 'example.com';
const ROOM = '!room:example.com';
const LOCAL_USER = '@alice:example.com';

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
  hashes: string | null;
  signatures: string | null;
};

type RoomRow = {
  room_id: string;
  room_version: string;
  is_public?: number;
  created_at?: number;
};

type ServerKeyRow = {
  key_id: string;
  public_key: string;
  private_key_jwk: string | null;
  key_version: number | null;
  valid_from: number;
  valid_until: number | null;
  is_current: number;
};

type MediaRow = { media_id: string; content_type: string; filename?: string | null };

type FedDbOptions = {
  media?: MediaRow[];
  rooms?: RoomRow[];
  events?: EventRow[];
  /** Map `${roomId}|${eventType}|${stateKey}` → event_id */
  roomState?: Map<string, string>;
  aliases?: Record<string, string>;
  users?: Array<{ user_id: string; display_name?: string | null; avatar_url?: string | null }>;
  devices?: Array<{ user_id: string; device_id: string; display_name?: string | null }>;
  memberships?: Array<{ room_id: string; user_id: string; membership: string }>;
  serverKeys?: ServerKeyRow[];
  federationTxns?: Record<string, string>;
  processedPdus?: Record<string, { accepted: number; rejection_reason: string | null }>;
  crossSigningSigs?: Array<{
    user_id: string;
    key_id: string;
    signer_user_id: string;
    signer_key_id: string;
    signature: string;
  }>;
  deviceKeyChanges?: Array<{ user_id: string; stream_position: number }>;
  failInsert?: boolean;
  selectBarrier?: SelectBarrier;
};

function stateKey(roomId: string, eventType: string, sk: string) {
  return `${roomId}|${eventType}|${sk}`;
}

function createFedDb(opts: FedDbOptions = {}) {
  const rooms = new Map((opts.rooms ?? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }]).map((r) => [r.room_id, r]));
  const events = new Map((opts.events ?? []).map((e) => [e.event_id, e]));
  const roomState = opts.roomState ?? new Map<string, string>();
  const aliases = { ...(opts.aliases ?? {}) };
  const users = new Map((opts.users ?? [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }]).map((u) => [u.user_id, u]));
  const devices = [...(opts.devices ?? [{ user_id: LOCAL_USER, device_id: 'DEVICEA', display_name: 'Phone' }])];
  const memberships = [...(opts.memberships ?? [{ room_id: ROOM, user_id: `@member:${FED_ORIGIN}`, membership: 'join' }])];
  const serverKeys = [...(opts.serverKeys ?? [])];
  const federationTxns = { ...(opts.federationTxns ?? {}) };
  const processedPdus = { ...(opts.processedPdus ?? {}) };
  const crossSigningSigs = [...(opts.crossSigningSigs ?? [])];
  const deviceKeyChanges = [...(opts.deviceKeyChanges ?? [])];
  const mediaRows = new Map((opts.media ?? []).map((m) => [m.media_id, m]));
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };

  function eventFromState(roomId: string, eventType: string, sk = ''): EventRow | null {
    const eid = roomState.get(stateKey(roomId, eventType, sk));
    if (!eid) return null;
    return events.get(eid) ?? null;
  }

  function toPduSelect(e: EventRow) {
    return { ...e };
  }

  const db = {
    rooms,
    events,
    roomState,
    aliases,
    users,
    devices,
    memberships,
    serverKeys,
    federationTxns,
    processedPdus,
    inserts,
    prepare(sql: string) {
      async function runWithArgs(args: unknown[]) {
        inserts.push({ sql, args });
        if (opts.failInsert) throw new Error('simulated insert failure');

        if (sql.includes('INSERT OR REPLACE INTO processed_pdus') || sql.includes('INSERT INTO processed_pdus')) {
          const [eventId, , , , accepted, reason] = args as [
            string,
            string,
            string,
            number,
            number,
            string | null,
          ];
          processedPdus[eventId] = {
            accepted: accepted ?? 0,
            rejection_reason: reason ?? null,
          };
        }
        if (sql.includes('INSERT INTO federation_transactions') || sql.includes('INSERT OR REPLACE INTO federation_transactions')) {
          const [txnId, origin, , response] = args as [string, string, number, string];
          federationTxns[`${origin}|${txnId}`] = response;
        }
        if (sql.includes('UPDATE server_keys SET is_current = 0')) {
          for (const k of serverKeys) k.is_current = 0;
        }
        if (sql.includes('INSERT INTO server_keys')) {
          const [keyId, publicKey, , privateKeyJwk, validFrom, validUntil] = args as [
            string,
            string,
            string,
            string,
            number,
            number,
          ];
          serverKeys.push({
            key_id: keyId,
            public_key: publicKey,
            private_key_jwk: privateKeyJwk,
            key_version: 2,
            valid_from: validFrom,
            valid_until: validUntil,
            is_current: 1,
          });
        }
        if (sql.includes('INSERT OR IGNORE INTO events') || sql.includes('INSERT INTO events')) {
          const [
            eventId,
            roomId,
            sender,
            eventType,
            stateKeyVal,
            content,
            originServerTs,
            depth,
            authEvents,
            prevEvents,
            ,
            signatures,
          ] = args as [
            string,
            string,
            string,
            string,
            string | null,
            string,
            number,
            number,
            string,
            string,
            string | null,
            string | null,
          ];
          events.set(eventId, {
            event_id: eventId,
            room_id: roomId,
            sender,
            event_type: eventType,
            state_key: stateKeyVal,
            content,
            origin_server_ts: originServerTs,
            depth,
            auth_events: authEvents,
            prev_events: prevEvents,
            hashes: null,
            signatures,
          });
        }
        if (sql.includes('INSERT OR REPLACE INTO room_state')) {
          const [roomId, eventType, sk, eventId] = args as [string, string, string, string];
          roomState.set(stateKey(roomId, eventType, sk), eventId);
        }
        if (sql.includes('INSERT OR REPLACE INTO room_memberships')) {
          const [roomId, userId, membership] = args as [string, string, string];
          memberships.push({ room_id: roomId, user_id: userId, membership });
        }
        return { success: true, meta: { changes: 1 } };
      }

      const stmt = {
        async first<T>() {
          return firstWithArgs<T>([]);
        },
        async all<T>() {
          return allWithArgs<T>([]);
        },
        async run() {
          return runWithArgs([]);
        },
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return firstWithArgs<T>(args);
            },
            async all<T>() {
              return allWithArgs<T>(args);
            },
            async run() {
              return runWithArgs(args);
            },
          };
        },
      };

      async function firstWithArgs<T>(args: unknown[]): Promise<T | null> {
        await withBarrier(
          selectBarrier,
          selectWaiters,
          () => {
            selectBarrier = undefined;
          },
          sql,
          args
        );
        if (sql.includes('SELECT response FROM federation_transactions')) {
          const [origin, txnId] = args as [string, string];
          const response = federationTxns[`${origin}|${txnId}`];
          return (response ? { response } : null) as T;
        }
        if (sql.includes('SELECT accepted, rejection_reason FROM processed_pdus')) {
          const [eventId] = args as [string];
          const row = processedPdus[eventId];
          return (row ?? null) as T;
        }
        if (sql.includes('SELECT room_id, room_version FROM rooms') || (sql.includes('SELECT room_id FROM rooms') && sql.includes('WHERE room_id'))) {
          const [roomId] = args as [string];
          const room = rooms.get(roomId);
          if (!room) return null;
          if (sql.includes('room_version')) {
            return { room_id: room.room_id, room_version: room.room_version } as T;
          }
          return { room_id: room.room_id } as T;
        }
        if (sql.includes('FROM server_keys') && sql.includes('is_current = 1') && sql.includes('key_version = 2') && !sql.includes('ORDER BY')) {
          const k = serverKeys.find((s) => s.is_current === 1 && s.key_version === 2);
          return (k
            ? { key_id: k.key_id, private_key_jwk: k.private_key_jwk }
            : null) as T;
        }
        if (sql.includes('FROM server_keys') && sql.includes('WHERE key_id = ?')) {
          const [keyId] = args as [string];
          const k = serverKeys.find((s) => s.key_id === keyId);
          return (k
            ? {
                key_id: k.key_id,
                public_key: k.public_key,
                valid_from: k.valid_from,
                valid_until: k.valid_until,
              }
            : null) as T;
        }
        if (sql.includes('SELECT room_id FROM room_aliases')) {
          const [alias] = args as [string];
          const roomId = aliases[alias];
          return (roomId ? { room_id: roomId } : null) as T;
        }
        if (sql.includes('SELECT display_name, avatar_url FROM users')) {
          const [userId] = args as [string];
          const u = users.get(userId);
          return (u
            ? { display_name: u.display_name ?? null, avatar_url: u.avatar_url ?? null }
            : null) as T;
        }
        if (sql.includes('SELECT user_id FROM users WHERE user_id')) {
          const [userId] = args as [string];
          return (users.has(userId) ? { user_id: userId } : null) as T;
        }
        if (sql.includes('ORDER BY depth DESC LIMIT 1') && sql.includes('FROM events') && !sql.includes('depth <')) {
          const [roomId] = args as [string];
          const list = [...events.values()]
            .filter((e) => e.room_id === roomId)
            .sort((a, b) => b.depth - a.depth);
          return (list[0] ? { event_id: list[0].event_id, depth: list[0].depth } : null) as T;
        }
        if (sql.includes('SELECT MIN(depth) as min_depth')) {
          const ids = args as string[];
          let min = Infinity;
          for (const id of ids) {
            const e = events.get(id);
            if (e && e.depth < min) min = e.depth;
          }
          return (Number.isFinite(min) ? { min_depth: min } : { min_depth: 0 }) as T;
        }
        if (
          sql.includes('FROM events') &&
          sql.includes('WHERE event_id = ?') &&
          sql.includes('AND room_id = ?') &&
          sql.includes('AND depth >= ?')
        ) {
          const [eventId, roomId, minDepth] = args as [string, string, number];
          const e = events.get(eventId);
          if (!e || e.room_id !== roomId || e.depth < minDepth) return null;
          return toPduSelect(e) as T;
        }
        if (
          sql.includes('FROM events') &&
          sql.includes('WHERE event_id = ?') &&
          sql.includes('AND room_id = ?') &&
          !sql.includes('AND depth')
        ) {
          const [eventId, roomId] = args as [string, string];
          const e = events.get(eventId);
          if (!e || e.room_id !== roomId) return null;
          return { event_id: e.event_id, auth_events: e.auth_events } as T;
        }
        if (sql.includes('FROM events') && sql.includes('WHERE event_id = ?') && !sql.includes('AND room_id')) {
          const [eventId] = args as [string];
          const e = events.get(eventId);
          return (e ? toPduSelect(e) : null) as T;
        }
        if (sql.includes("rs.event_type = 'm.room.create'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.create');
          if (!e) return null;
          if (sql.includes('e.content')) {
            return {
              event_id: e.event_id,
              event_type: e.event_type,
              state_key: e.state_key ?? '',
              content: e.content,
              sender: e.sender,
              origin_server_ts: e.origin_server_ts,
            } as T;
          }
          return { event_id: e.event_id } as T;
        }
        if (sql.includes("rs.event_type = 'm.room.join_rules'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.join_rules');
          if (!e) return null;
          if (sql.includes('e.content')) {
            return {
              event_id: e.event_id,
              event_type: e.event_type,
              state_key: e.state_key ?? '',
              content: e.content,
              sender: e.sender,
              origin_server_ts: e.origin_server_ts,
            } as T;
          }
          return { event_id: e.event_id } as T;
        }
        if (sql.includes("rs.event_type = 'm.room.power_levels'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.power_levels');
          return (e ? { event_id: e.event_id } : null) as T;
        }
        if (
          sql.includes("rs.event_type = 'm.room.member'") &&
          sql.includes('rs.state_key = ?') &&
          sql.includes('SELECT e.event_id')
        ) {
          const [roomId, sk] = args as [string, string];
          const e = eventFromState(roomId, 'm.room.member', sk);
          return (e ? { event_id: e.event_id } : null) as T;
        }
        if (sql.includes('FROM room_memberships') && sql.includes('SUBSTR(user_id')) {
          const [roomId, origin] = args as [string, string];
          const hit = memberships.find(
            (m) =>
              m.room_id === roomId &&
              m.membership === 'join' &&
              m.user_id.endsWith(`:${origin}`)
          );
          return (hit ? { 1: 1 } : null) as T;
        }
        if (
          sql.includes('SELECT membership FROM room_memberships') &&
          sql.includes('WHERE room_id = ? AND user_id = ?')
        ) {
          const [roomId, userId] = args as [string, string];
          const hit = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
          return (hit ? { membership: hit.membership } : null) as T;
        }
        if (sql.includes('SELECT COUNT(*) as count FROM rooms WHERE is_public = 1')) {
          const count = [...rooms.values()].filter((r) => r.is_public === 1).length;
          return { count } as T;
        }
        if (sql.includes("rs.event_type = 'm.room.name'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.name');
          if (!e) return null;
          return {
            content: e.content,
            event_type: e.event_type,
            state_key: e.state_key ?? '',
            sender: e.sender,
            origin_server_ts: e.origin_server_ts,
          } as T;
        }
        if (sql.includes("rs.event_type = 'm.room.topic'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.topic');
          return (e ? { content: e.content } : null) as T;
        }
        if (sql.includes("rs.event_type = 'm.room.canonical_alias'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.canonical_alias');
          if (!e) return null;
          return {
            content: e.content,
            event_type: e.event_type,
            state_key: e.state_key ?? '',
            sender: e.sender,
          } as T;
        }
        if (sql.includes("rs.event_type = 'm.room.avatar'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.avatar');
          if (!e) return null;
          return {
            content: e.content,
            event_type: e.event_type,
            state_key: e.state_key ?? '',
            sender: e.sender,
          } as T;
        }
        if (sql.includes("rs.event_type = 'm.room.history_visibility'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.history_visibility');
          return (e ? { content: e.content } : null) as T;
        }
        if (sql.includes("rs.event_type = 'm.room.guest_access'")) {
          const [roomId] = args as [string];
          const e = eventFromState(roomId, 'm.room.guest_access');
          return (e ? { content: e.content } : null) as T;
        }
        if (sql.includes('SELECT COUNT(*) as count FROM room_memberships') || sql.includes("membership = 'join'")) {
          if (sql.includes('COUNT')) {
            const [roomId] = args as [string];
            const count = memberships.filter((m) => m.room_id === roomId && m.membership === 'join').length;
            return { count } as T;
          }
        }
        if (sql.includes('FROM media WHERE media_id = ?')) {
          const [mediaId] = args as [string];
          const m = mediaRows.get(mediaId);
          if (!m) return null;
          if (sql.includes('filename')) {
            return { content_type: m.content_type, filename: m.filename ?? null } as T;
          }
          return { content_type: m.content_type } as T;
        }
        if (sql.includes('SELECT MAX(stream_position) as stream_id FROM device_key_changes')) {
          const [userId] = args as [string];
          const rows = deviceKeyChanges.filter((d) => d.user_id === userId);
          const max = rows.reduce((a, b) => Math.max(a, b.stream_position), 0);
          return { stream_id: max || null } as T;
        }
        if (
          sql.includes('origin_server_ts <= ?') &&
          sql.includes('ORDER BY origin_server_ts DESC')
        ) {
          const [roomId, ts] = args as [string, number];
          const list = [...events.values()]
            .filter((e) => e.room_id === roomId && e.origin_server_ts <= ts)
            .sort((a, b) => b.origin_server_ts - a.origin_server_ts);
          return (list[0]
            ? { event_id: list[0].event_id, origin_server_ts: list[0].origin_server_ts }
            : null) as T;
        }
        if (
          sql.includes('origin_server_ts >= ?') &&
          sql.includes('ORDER BY origin_server_ts ASC')
        ) {
          const [roomId, ts] = args as [string, number];
          const list = [...events.values()]
            .filter((e) => e.room_id === roomId && e.origin_server_ts >= ts)
            .sort((a, b) => a.origin_server_ts - b.origin_server_ts);
          return (list[0]
            ? { event_id: list[0].event_id, origin_server_ts: list[0].origin_server_ts }
            : null) as T;
        }
        return null;
      }

      async function allWithArgs<T>(args: unknown[]): Promise<{ results: T[] }> {
        await withBarrier(
          selectBarrier,
          selectWaiters,
          () => {
            selectBarrier = undefined;
          },
          sql,
          args
        );
        if (sql.includes('FROM server_keys') && sql.includes('is_current = 1') && sql.includes('ORDER BY key_version DESC')) {
          return {
            results: serverKeys
              .filter((k) => k.is_current === 1)
              .sort((a, b) => (b.key_version ?? 0) - (a.key_version ?? 0)) as T[],
          };
        }
        if (sql.includes('FROM server_keys') && sql.includes('is_current = 1') && sql.includes('SELECT key_id, public_key, valid_until')) {
          return {
            results: serverKeys
              .filter((k) => k.is_current === 1)
              .map((k) => ({
                key_id: k.key_id,
                public_key: k.public_key,
                valid_until: k.valid_until,
              })) as T[],
          };
        }
        if (
          sql.includes('FROM room_state rs') &&
          sql.includes('JOIN events e') &&
          sql.includes('WHERE rs.room_id = ?') &&
          !sql.includes('rs.event_type')
        ) {
          const [roomId] = args as [string];
          const results: EventRow[] = [];
          for (const [k, eid] of roomState) {
            if (!k.startsWith(`${roomId}|`)) continue;
            const e = events.get(eid);
            if (e) results.push(toPduSelect(e));
          }
          return { results: results as T[] };
        }
        if (sql.includes("rs.event_type = 'm.space.child'")) {
          const [roomId] = args as [string];
          const limit = typeof args[1] === 'number' ? args[1] : undefined;
          const offset = typeof args[2] === 'number' ? args[2] : 0;
          const children: Array<{ state_key: string; content: string }> = [];
          for (const [k, eid] of roomState) {
            if (!k.startsWith(`${roomId}|m.space.child|`)) continue;
            const e = events.get(eid);
            if (e) children.push({ state_key: e.state_key ?? '', content: e.content });
          }
          const sliced = limit !== undefined ? children.slice(offset, offset + limit) : children;
          return { results: sliced as T[] };
        }
        if (sql.includes('FROM events') && sql.includes('depth < ?')) {
          const [roomId, maxDepth, limit] = args as [string, number, number];
          const list = [...events.values()]
            .filter((e) => e.room_id === roomId && e.depth < maxDepth)
            .sort((a, b) => b.depth - a.depth)
            .slice(0, limit)
            .map(toPduSelect);
          return { results: list as T[] };
        }
        if (sql.includes('FROM events') && sql.includes('ORDER BY depth DESC') && sql.includes('LIMIT ?')) {
          const [roomId, limit] = args as [string, number];
          const list = [...events.values()]
            .filter((e) => e.room_id === roomId)
            .sort((a, b) => b.depth - a.depth)
            .slice(0, limit)
            .map(toPduSelect);
          return { results: list as T[] };
        }
        if (sql.includes('FROM rooms r') && sql.includes('is_public = 1')) {
          const limit = Number(args[args.length - 2] ?? args[0]);
          const offset = Number(args[args.length - 1] ?? 0);
          const list = [...rooms.values()]
            .filter((r) => r.is_public === 1)
            .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
            .slice(offset, offset + limit)
            .map((r) => ({ room_id: r.room_id }));
          return { results: list as T[] };
        }
        if (sql.includes('FROM devices WHERE user_id = ?')) {
          const [userId] = args as [string];
          return {
            results: devices
              .filter((d) => d.user_id === userId)
              .map((d) => ({ device_id: d.device_id, display_name: d.display_name ?? null })) as T[],
          };
        }
        if (sql.includes('FROM cross_signing_signatures')) {
          const [userId, keyId] = args as [string, string];
          return {
            results: crossSigningSigs
              .filter((s) => s.user_id === userId && s.key_id === keyId)
              .map((s) => ({
                signer_user_id: s.signer_user_id,
                signer_key_id: s.signer_key_id,
                signature: s.signature,
              })) as T[],
          };
        }
        return { results: [] as T[] };
      }

      return stmt;
    },
  };

  return db;
}

type KvStore = {
  data: Record<string, string>;
  get: (key: string, type?: string) => Promise<unknown>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

function mockKv(
  initial: Record<string, string> = {},
  opts: {
    getBarrier?: KvBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
  } = {}
): KvStore {
  const data = { ...initial };
  let getBarrier = opts.getBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  let getCount = 0;
  return {
    data,
    get: async (key: string, type?: string) => {
      await withBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      getCount += 1;
      const v = data[key];
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterGets.next);
      }
      if (v === undefined) return null;
      if (type === 'json') {
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      }
      return v;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
}

function createUserKeysStub(deviceKeys: Record<string, unknown> = {}, crossSigning: Record<string, unknown> = {}) {
  return {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/device-keys/get') {
          const deviceId = url.searchParams.get('device_id');
          if (deviceId) {
            const keys = (deviceKeys as Record<string, unknown>)[deviceId] ?? null;
            return new Response(JSON.stringify(keys), { status: keys ? 200 : 404 });
          }
          return new Response(JSON.stringify(deviceKeys), { status: 200 });
        }
        if (url.pathname === '/cross-signing/get') {
          return new Response(JSON.stringify(crossSigning), { status: 200 });
        }
        if (url.pathname.includes('one-time') || url.pathname.includes('claim')) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    }),
  };
}

function makeEnv(
  db: ReturnType<typeof createFedDb>,
  extras: Partial<Env> & {
    sessions?: KvStore;
    cache?: KvStore;
    oneTimeKeys?: KvStore;
    userKeys?: ReturnType<typeof createUserKeysStub>;
    media?: R2Store;
  } = {}
): Env {
  const sessions = extras.sessions ?? mockKv();
  const cache = extras.cache ?? mockKv();
  const oneTimeKeys = extras.oneTimeKeys ?? mockKv();
  const media = extras.media ?? mockR2();
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: db as unknown as D1Database,
    SESSIONS: sessions as unknown as KVNamespace,
    CACHE: cache as unknown as KVNamespace,
    ONE_TIME_KEYS: oneTimeKeys as unknown as KVNamespace,
    USER_KEYS: (extras.userKeys ?? createUserKeysStub()) as unknown as DurableObjectNamespace,
    MEDIA: media as unknown as R2Bucket,
    ...extras,
  } as Env;
}

async function req(
  method: string,
  path: string,
  env: Env,
  body?: unknown
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await federation.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function makeEvent(overrides: Partial<EventRow> & Pick<EventRow, 'event_id' | 'event_type'>): EventRow {
  return {
    room_id: ROOM,
    sender: LOCAL_USER,
    state_key: '',
    content: '{}',
    origin_server_ts: 1_700_000_000_000,
    depth: 1,
    auth_events: '[]',
    prev_events: '[]',
    hashes: null,
    signatures: null,
    ...overrides,
  };
}


type R2Store = {
  data: Record<string, { body: Uint8Array }>;
  get: (key: string) => Promise<{ body: ReadableStream; arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  put: (key: string, value: Uint8Array) => Promise<void>;
};

function mockR2(
  initial: Record<string, Uint8Array> = {},
  opts: { getBarrier?: R2Barrier } = {}
): R2Store {
  const data: Record<string, { body: Uint8Array }> = {};
  for (const [k, v] of Object.entries(initial)) data[k] = { body: v };
  let getBarrier = opts.getBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  return {
    data,
    get: async (key: string) => {
      await withBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      const hit = data[key];
      if (!hit) return null;
      const buf = hit.body;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(buf);
            controller.close();
          },
        }),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    },
    put: async (key: string, value: Uint8Array) => {
      data[key] = { body: value };
    },
  };
}



const MEDIA_ID = 'mxc_media_abc';
const REMOTE_USER = `@remote:${FED_ORIGIN}`;

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

beforeEach(() => {
  federationOrigin = FED_ORIGIN;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  federationOrigin = FED_ORIGIN;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});


// ---------------------------------------------------------------------------
// Senary soft floods + concurrent races after tip #317 / post-#315–#319 wave
// ---------------------------------------------------------------------------

describe('soft senary federation keys-claim/openid/3pid exact after #317', () => {
  for (let i = 0; i < 12; i++) {
    it(`device_keys missing exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const bodies = [{}, { device_keys: null }, { device_keys: 'x' }, { nope: true }];
      const res = await req(
        'POST',
        '/_matrix/federation/v1/user/keys/query',
        env,
        bodies[i % bodies.length]
      );
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_MISSING_PARAM');
      expect((res.body as { error: string }).error).toBe(
        'Missing required parameter: device_keys'
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`one_time_keys missing exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const bodies = [{}, { one_time_keys: null }, { one_time_keys: 1 }, { other: [] }];
      const res = await req(
        'POST',
        '/_matrix/federation/v1/user/keys/claim',
        env,
        bodies[i % bodies.length]
      );
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_MISSING_PARAM');
      expect((res.body as { error: string }).error).toBe(
        'Missing required parameter: one_time_keys'
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`3pid Event must be a membership invite exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: i % 2 === 0 ? 'm.room.message' : 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: i % 2 === 0 ? 'invite' : 'join' },
        }
      );
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_INVALID_PARAM');
      expect((res.body as { error: string }).error).toBe('Event must be a membership invite');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`3pid Room ID mismatch exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: `!other${i}:example.com`,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite' },
        }
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('Room ID mismatch');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`3pid Missing third_party_invite exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const bodies = [
        {
          type: 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite' },
        },
        {
          type: 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite', third_party_invite: {} },
        },
      ];
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        bodies[i % bodies.length]
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        'Missing third_party_invite or signed data'
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`3pid Incomplete signed data exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const signedVariants = [
        { token: 't', signatures: { a: { b: 'c' } } },
        { mxid: LOCAL_USER, signatures: { a: { b: 'c' } } },
        { mxid: LOCAL_USER, token: 't' },
      ];
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: {
            membership: 'invite',
            third_party_invite: { signed: signedVariants[i % signedVariants.length] },
          },
        }
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        'Incomplete signed data in third_party_invite'
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`openid Invalid or expired exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'GET',
        `/_matrix/federation/v1/openid/userinfo?access_token=missing-${i}`,
        env
      );
      expect(res.status).toBe(401);
      expect((res.body as { error: string }).error).toBe('Invalid or expired OpenID token');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`openid OpenID token has expired exact flood-${i}`, async () => {
      const sessions = mockKv({
        [`openid:exp${i}`]: JSON.stringify({
          user_id: LOCAL_USER,
          expires_at: Date.now() - 5_000 - i,
        }),
      });
      const env = makeEnv(createFedDb(), { sessions });
      const res = await req(
        'GET',
        `/_matrix/federation/v1/openid/userinfo?access_token=exp${i}`,
        env
      );
      expect(res.status).toBe(401);
      expect((res.body as { error: string }).error).toBe('OpenID token has expired');
    });
  }
});

describe('race senary federation keys-claim/openid/3pid exact after #317', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('device_keys∥one_time_keys missing isolation', async () => {
    const env = makeEnv(createFedDb());
    const [dq, claim] = await Promise.all([
      req('POST', '/_matrix/federation/v1/user/keys/query', env, {}),
      req('POST', '/_matrix/federation/v1/user/keys/claim', env, {}),
    ]);
    expect(statusesOf([dq, claim])).toEqual([400, 400]);
    expect((dq.body as { error: string }).error).toBe(
      'Missing required parameter: device_keys'
    );
    expect((claim.body as { error: string }).error).toBe(
      'Missing required parameter: one_time_keys'
    );
  });

  it('3pid not-invite∥Room ID mismatch isolation', async () => {
    const env = makeEnv(createFedDb());
    const [notInvite, mismatch] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'join' },
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: '!other:example.com',
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite' },
        }
      ),
    ]);
    expect(statusesOf([notInvite, mismatch])).toEqual([400, 400]);
    expect((notInvite.body as { error: string }).error).toBe(
      'Event must be a membership invite'
    );
    expect((mismatch.body as { error: string }).error).toBe('Room ID mismatch');
  });

  it('3pid Missing third_party∥Incomplete signed isolation', async () => {
    const env = makeEnv(createFedDb());
    const [missing, incomplete] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite' },
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: {
            membership: 'invite',
            third_party_invite: { signed: { mxid: LOCAL_USER, token: 't' } },
          },
        }
      ),
    ]);
    expect(statusesOf([missing, incomplete])).toEqual([400, 400]);
    expect((missing.body as { error: string }).error).toBe(
      'Missing third_party_invite or signed data'
    );
    expect((incomplete.body as { error: string }).error).toBe(
      'Incomplete signed data in third_party_invite'
    );
  });

  it('openid missing∥expired∥invalid triple isolation', async () => {
    const sessions = mockKv({
      'openid:exp_tri': JSON.stringify({
        user_id: LOCAL_USER,
        expires_at: Date.now() - 10_000,
      }),
    });
    const env = makeEnv(createFedDb(), { sessions });
    const [missing, expired, invalid] = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=exp_tri', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=nope_tri', env),
    ]);
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toBe(
      'Missing required parameter: access_token'
    );
    expect(expired.status).toBe(401);
    expect((expired.body as { error: string }).error).toBe('OpenID token has expired');
    expect(invalid.status).toBe(401);
    expect((invalid.body as { error: string }).error).toBe('Invalid or expired OpenID token');
  });

  it('device_keys missing∥openid missing isolation', async () => {
    const env = makeEnv(createFedDb());
    const [keys, openid] = await Promise.all([
      req('POST', '/_matrix/federation/v1/user/keys/query', env, { device_keys: null }),
      req('GET', '/_matrix/federation/v1/openid/userinfo', env),
    ]);
    expect(statusesOf([keys, openid])).toEqual([400, 400]);
    expect((keys.body as { error: string }).error).toBe(
      'Missing required parameter: device_keys'
    );
    expect((openid.body as { error: string }).error).toBe(
      'Missing required parameter: access_token'
    );
  });

  it('one_time_keys missing∥3pid not-invite isolation', async () => {
    const env = makeEnv(createFedDb());
    const [claim, invite] = await Promise.all([
      req('POST', '/_matrix/federation/v1/user/keys/claim', env, { one_time_keys: 'bad' }),
      req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.message',
          room_id: ROOM,
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite' },
        }
      ),
    ]);
    expect(statusesOf([claim, invite])).toEqual([400, 400]);
    expect((claim.body as { error: string }).error).toBe(
      'Missing required parameter: one_time_keys'
    );
    expect((invite.body as { error: string }).error).toBe(
      'Event must be a membership invite'
    );
  });

  it('openid expired∥invalid∥3pid Room ID mismatch isolation', async () => {
    const sessions = mockKv({
      'openid:exp_mix': JSON.stringify({
        user_id: LOCAL_USER,
        expires_at: Date.now() - 1,
      }),
    });
    const env = makeEnv(createFedDb(), { sessions });
    const [expired, invalid, mismatch] = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=exp_mix', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=gone_mix', env),
      req(
        'PUT',
        `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
        env,
        {
          type: 'm.room.member',
          room_id: '!mismatch:example.com',
          sender: '@inviter:remote.example.com',
          state_key: LOCAL_USER,
          content: { membership: 'invite' },
        }
      ),
    ]);
    expect(expired.status).toBe(401);
    expect((expired.body as { error: string }).error).toBe('OpenID token has expired');
    expect(invalid.status).toBe(401);
    expect((invalid.body as { error: string }).error).toBe('Invalid or expired OpenID token');
    expect(mismatch.status).toBe(400);
    expect((mismatch.body as { error: string }).error).toBe('Room ID mismatch');
  });

  for (let i = 0; i < 12; i++) {
    it(`senary federation race flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const results = await Promise.all([
        req('POST', '/_matrix/federation/v1/user/keys/query', env, {}),
        req('POST', '/_matrix/federation/v1/user/keys/claim', env, {}),
        req(
          'PUT',
          `/_matrix/federation/v1/exchange_third_party_invite/${encodeURIComponent(ROOM)}`,
          env,
          {
            type: 'm.room.member',
            room_id: ROOM,
            sender: '@a:remote.example.com',
            state_key: LOCAL_USER,
            content: { membership: 'leave' },
          }
        ),
        req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=flood-${i}`, env),
      ]);
      expect(statusesOf(results)).toEqual([400, 400, 400, 401]);
      expect((results[0].body as { error: string }).error).toBe(
        'Missing required parameter: device_keys'
      );
      expect((results[1].body as { error: string }).error).toBe(
        'Missing required parameter: one_time_keys'
      );
      expect((results[2].body as { error: string }).error).toBe(
        'Event must be a membership invite'
      );
      expect((results[3].body as { error: string }).error).toBe(
        'Invalid or expired OpenID token'
      );
    });
  }
});
