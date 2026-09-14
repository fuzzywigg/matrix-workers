/**
 * TOKENMAXX HEAVY deepen after #118 — different slice: federation S2S API routes.
 * Avoids voip/rtc/calls (#118), sync (#117), rooms (#114), oidc (#115), media (#113).
 * Skips exchange_third_party_invite (covered by federation-exchange-third-party-invite).
 * Tests-only — no product inventing. Exercises Hono app.request() branches.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const FED_ORIGIN = 'remote.example.com';
let federationOrigin: string | undefined = FED_ORIGIN;

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

import federation, {
  isModernRoomVersion,
  isValidServerName,
} from '../src/api/federation';
import { generateSigningKeyPair } from '../src/utils/crypto';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const LOCAL_USER = '@alice:example.com';
const REMOTE_USER = '@bob:remote.example.com';

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

type FedDbOptions = {
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
  const inserts: Array<{ sql: string; args: unknown[] }> = [];

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

function mockKv(initial: Record<string, string> = {}): KvStore {
  const data = { ...initial };
  return {
    data,
    get: async (key: string, type?: string) => {
      const v = data[key];
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
  } = {}
): Env {
  const sessions = extras.sessions ?? mockKv();
  const cache = extras.cache ?? mockKv();
  const oneTimeKeys = extras.oneTimeKeys ?? mockKv();
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: db as unknown as D1Database,
    SESSIONS: sessions as unknown as KVNamespace,
    CACHE: cache as unknown as KVNamespace,
    ONE_TIME_KEYS: oneTimeKeys as unknown as KVNamespace,
    USER_KEYS: (extras.userKeys ?? createUserKeysStub()) as unknown as DurableObjectNamespace,
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

function seedBasicRoom(extra: Partial<FedDbOptions> = {}) {
  const create = makeEvent({
    event_id: '$create:example.com',
    event_type: 'm.room.create',
    content: JSON.stringify({ creator: LOCAL_USER, room_version: '10' }),
    depth: 1,
  });
  const joinRules = makeEvent({
    event_id: '$jr:example.com',
    event_type: 'm.room.join_rules',
    content: JSON.stringify({ join_rule: 'public' }),
    depth: 2,
  });
  const power = makeEvent({
    event_id: '$pl:example.com',
    event_type: 'm.room.power_levels',
    content: JSON.stringify({ users: { [LOCAL_USER]: 100 } }),
    depth: 3,
  });
  const name = makeEvent({
    event_id: '$name:example.com',
    event_type: 'm.room.name',
    content: JSON.stringify({ name: 'Public Room' }),
    depth: 4,
  });
  const member = makeEvent({
    event_id: '$member:example.com',
    event_type: 'm.room.member',
    state_key: LOCAL_USER,
    sender: LOCAL_USER,
    content: JSON.stringify({ membership: 'join' }),
    depth: 5,
    auth_events: JSON.stringify(['$create:example.com', '$jr:example.com', '$pl:example.com']),
  });
  const roomState = new Map<string, string>([
    [stateKey(ROOM, 'm.room.create', ''), create.event_id],
    [stateKey(ROOM, 'm.room.join_rules', ''), joinRules.event_id],
    [stateKey(ROOM, 'm.room.power_levels', ''), power.event_id],
    [stateKey(ROOM, 'm.room.name', ''), name.event_id],
    [stateKey(ROOM, 'm.room.member', LOCAL_USER), member.event_id],
  ]);
  return createFedDb({
    events: [create, joinRules, power, name, member],
    roomState,
    ...extra,
  });
}

describe('exported federation helpers', () => {
  it('isModernRoomVersion treats v1-2 as legacy and v3+ / custom as modern', () => {
    expect(isModernRoomVersion('1')).toBe(false);
    expect(isModernRoomVersion('2')).toBe(false);
    expect(isModernRoomVersion('3')).toBe(true);
    expect(isModernRoomVersion('10')).toBe(true);
    expect(isModernRoomVersion('12')).toBe(true);
    expect(isModernRoomVersion('org.example.custom')).toBe(true);
  });

  it('isValidServerName rejects empty, oversized, and SSRF-ish names', () => {
    expect(isValidServerName('')).toBe(false);
    expect(isValidServerName('a'.repeat(256))).toBe(false);
    expect(isValidServerName('matrix.org')).toBe(true);
    expect(isValidServerName('matrix.org:8448')).toBe(true);
    expect(isValidServerName('127.0.0.1')).toBe(false);
    expect(isValidServerName('localhost')).toBe(false);
  });
});

describe('GET /_matrix/federation/v1/version', () => {
  it('returns server name and version without auth', async () => {
    const env = makeEnv(createFedDb());
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect(body).toEqual({
      server: { name: 'matrix-worker', version: 'test-0.1.0' },
    });
  });

  it('falls back to 0.1.0 when SERVER_VERSION unset', async () => {
    const env = makeEnv(createFedDb());
    delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { version: string } }).server.version).toBe('0.1.0');
  });
});

describe('federation key endpoints', () => {
  let restore: (() => void) | undefined;
  let serverKeyPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    serverKeyPair = await generateSigningKeyPair();
  });

  afterAll(() => restore?.());

  function keysDb(extra: Partial<ServerKeyRow> = {}) {
    return createFedDb({
      serverKeys: [
        {
          key_id: serverKeyPair.keyId,
          public_key: serverKeyPair.publicKey,
          private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk),
          key_version: 2,
          valid_from: Date.now() - 1000,
          valid_until: Date.now() + 86_400_000,
          is_current: 1,
          ...extra,
        },
      ],
    });
  }

  it('GET /_matrix/key/v2/server returns signed keys when secure key present', async () => {
    const { status, body } = await req('GET', '/_matrix/key/v2/server', makeEnv(keysDb()));
    expect(status).toBe(200);
    const b = body as {
      server_name: string;
      verify_keys: Record<string, { key: string }>;
      signatures?: Record<string, unknown>;
    };
    expect(b.server_name).toBe(SERVER);
    expect(b.verify_keys[serverKeyPair.keyId]).toEqual({ key: serverKeyPair.publicKey });
    expect(b.signatures).toBeDefined();
  });

  it('GET /_matrix/key/v2/server generates a new key when none exist', async () => {
    const db = createFedDb({ serverKeys: [] });
    const { status, body } = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(status).toBe(200);
    expect((body as { server_name: string }).server_name).toBe(SERVER);
    expect(db.serverKeys.length).toBeGreaterThan(0);
    expect(db.serverKeys.some((k) => k.key_version === 2)).toBe(true);
  });

  it('GET /_matrix/key/v2/server/:keyId returns specific key or 404', async () => {
    const env = makeEnv(keysDb());
    const ok = await req('GET', `/_matrix/key/v2/server/${encodeURIComponent(serverKeyPair.keyId)}`, env);
    expect(ok.status).toBe(200);
    expect((ok.body as { verify_keys: Record<string, unknown> }).verify_keys[serverKeyPair.keyId]).toBeDefined();

    const missing = await req('GET', '/_matrix/key/v2/server/ed25519:missing', env);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('POST /_matrix/key/v2/query validates body and batch size', async () => {
    const env = makeEnv(keysDb());
    const bad = await req('POST', '/_matrix/key/v2/query', env, '{bad');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ errcode: 'M_BAD_JSON' });

    const missing = await req('POST', '/_matrix/key/v2/query', env, {});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const tooMany: Record<string, Record<string, object>> = {};
    for (let i = 0; i < 101; i++) tooMany[`s${i}.example.com`] = { '': {} };
    const limited = await req('POST', '/_matrix/key/v2/query', env, { server_keys: tooMany });
    expect(limited.status).toBe(400);
    expect(limited.body).toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' });
  });

  it('POST /_matrix/key/v2/query returns 500 when notary key missing', async () => {
    const db = createFedDb({ serverKeys: [] });
    const { status, body } = await req('POST', '/_matrix/key/v2/query', makeEnv(db), {
      server_keys: { [SERVER]: { '': {} } },
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('POST /_matrix/key/v2/query returns own keys and skips invalid server names', async () => {
    getRemoteKeysWithNotarySignature.mockResolvedValue([]);
    const env = makeEnv(keysDb());
    const { status, body } = await req('POST', '/_matrix/key/v2/query', env, {
      server_keys: {
        [SERVER]: { '': {} },
        '127.0.0.1': { '': {} },
        'remote.example.com': { 'ed25519:abc': { minimum_valid_until_ts: 1 } },
      },
    });
    expect(status).toBe(200);
    const keys = (body as { server_keys: Array<{ server_name: string }> }).server_keys;
    expect(keys.some((k) => k.server_name === SERVER)).toBe(true);
    expect(getRemoteKeysWithNotarySignature).toHaveBeenCalled();
  });

  it('GET /_matrix/key/v2/query/:serverName handles own, invalid, remote, and empty', async () => {
    const env = makeEnv(keysDb());
    const invalid = await req('GET', '/_matrix/key/v2/query/127.0.0.1', env);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });

    const own = await req('GET', `/_matrix/key/v2/query/${SERVER}`, env);
    expect(own.status).toBe(200);
    expect((own.body as { server_keys: unknown[] }).server_keys).toHaveLength(1);

    getRemoteKeysWithNotarySignature.mockResolvedValueOnce([
      { server_name: 'remote.example.com', verify_keys: {}, valid_until_ts: 1, old_verify_keys: {} },
    ]);
    const remote = await req('GET', '/_matrix/key/v2/query/remote.example.com?minimum_valid_until_ts=10', env);
    expect(remote.status).toBe(200);

    getRemoteKeysWithNotarySignature.mockResolvedValueOnce([]);
    const empty = await req('GET', '/_matrix/key/v2/query/other.example.com', env);
    expect(empty.status).toBe(404);

    const noKey = await req('GET', `/_matrix/key/v2/query/${SERVER}`, makeEnv(createFedDb({ serverKeys: [] })));
    expect(noKey.status).toBe(500);
  });

  it('GET /_matrix/key/v2/query/:serverName/:keyId handles own missing/found and remote', async () => {
    const env = makeEnv(keysDb());
    const invalid = await req('GET', '/_matrix/key/v2/query/localhost/ed25519:x', env);
    expect(invalid.status).toBe(400);

    const missing = await req('GET', `/_matrix/key/v2/query/${SERVER}/ed25519:nope`, env);
    expect(missing.status).toBe(404);

    const found = await req(
      'GET',
      `/_matrix/key/v2/query/${SERVER}/${encodeURIComponent(serverKeyPair.keyId)}`,
      env
    );
    expect(found.status).toBe(200);

    getRemoteKeysWithNotarySignature.mockResolvedValueOnce([]);
    const remoteEmpty = await req('GET', '/_matrix/key/v2/query/remote.example.com/ed25519:x', env);
    expect(remoteEmpty.status).toBe(404);

    getRemoteKeysWithNotarySignature.mockResolvedValueOnce([
      { server_name: 'remote.example.com', verify_keys: { 'ed25519:x': { key: 'abc' } }, valid_until_ts: 1, old_verify_keys: {} },
    ]);
    const remoteOk = await req('GET', '/_matrix/key/v2/query/remote.example.com/ed25519:x', env);
    expect(remoteOk.status).toBe(200);

    const noNotary = await req(
      'GET',
      `/_matrix/key/v2/query/${SERVER}/${encodeURIComponent(serverKeyPair.keyId)}`,
      makeEnv(createFedDb({ serverKeys: [] }))
    );
    expect(noNotary.status).toBe(500);
  });



describe('PUT /_matrix/federation/v1/send/:txnId', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    getRoomState.mockReset();
    getRoomState.mockResolvedValue({});
  });

  it('rejects when federationOrigin missing', async () => {
    federationOrigin = undefined;
    const { status, body } = await req('PUT', '/_matrix/federation/v1/send/txn1', makeEnv(createFedDb()), {
      pdus: [],
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_UNAUTHORIZED' });
  });

  it('returns cached response for duplicate transaction', async () => {
    const cached = { pdus: { '$cached': {} } };
    const db = createFedDb({
      federationTxns: { [`${FED_ORIGIN}|txn-dup`]: JSON.stringify(cached) },
    });
    const { status, body } = await req('PUT', '/_matrix/federation/v1/send/txn-dup', makeEnv(db), {
      pdus: [],
    });
    expect(status).toBe(200);
    expect(body).toEqual(cached);
  });

  it('returns M_BAD_JSON for malformed body', async () => {
    const { status, body } = await req(
      'PUT',
      '/_matrix/federation/v1/send/txn-bad',
      makeEnv(createFedDb()),
      '{not-json'
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects invalid PDU structure and invalid sender', async () => {
    const db = seedBasicRoom();
    const { status, body } = await req('PUT', '/_matrix/federation/v1/send/txn-struct', makeEnv(db), {
      pdus: [
        { event_id: '$bad1', room_id: ROOM },
        { event_id: '$bad2', room_id: ROOM, sender: 'noserver', type: 'm.room.message', content: {} },
      ],
    });
    expect(status).toBe(200);
    const pdus = (body as { pdus: Record<string, { error?: string }> }).pdus;
    expect(pdus['$bad1'].error).toMatch(/Invalid PDU/);
    expect(pdus['$bad2'].error).toMatch(/Invalid sender/);
  });

  it('reuses previously processed PDU accept/reject', async () => {
    const db = seedBasicRoom({
      processedPdus: {
        '$ok': { accepted: 1, rejection_reason: null },
        '$no': { accepted: 0, rejection_reason: 'nope' },
      },
    });
    const { body } = await req('PUT', '/_matrix/federation/v1/send/txn-prev', makeEnv(db), {
      pdus: [
        { event_id: '$ok', room_id: ROOM, sender: REMOTE_USER, type: 'm.room.message', content: {} },
        { event_id: '$no', room_id: ROOM, sender: REMOTE_USER, type: 'm.room.message', content: {} },
      ],
    });
    const pdus = (body as { pdus: Record<string, { error?: string }> }).pdus;
    expect(pdus['$ok']).toEqual({});
    expect(pdus['$no'].error).toBe('nope');
  });

  it('rejects PDUs with invalid signatures', async () => {
    verifyRemoteSignature.mockResolvedValue(false);
    const db = seedBasicRoom();
    const { body } = await req('PUT', '/_matrix/federation/v1/send/txn-sig', makeEnv(db), {
      pdus: [
        {
          event_id: '$sig',
          room_id: ROOM,
          sender: REMOTE_USER,
          type: 'm.room.message',
          content: { body: 'hi' },
          hashes: { sha256: 'abc' },
          signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
        },
      ],
    });
    expect((body as { pdus: Record<string, { error: string }> }).pdus['$sig'].error).toMatch(
      /without valid signature/
    );
  });

  it('rejects modern room PDUs missing hashes.sha256', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    const db = seedBasicRoom();
    const { body } = await req('PUT', '/_matrix/federation/v1/send/txn-hash', makeEnv(db), {
      pdus: [
        {
          event_id: '$nohash',
          room_id: ROOM,
          sender: REMOTE_USER,
          type: 'm.room.message',
          content: { body: 'hi' },
          signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
        },
      ],
    });
    expect((body as { pdus: Record<string, { error: string }> }).pdus['$nohash'].error).toMatch(
      /Missing required hashes.sha256/
    );
  });

  it('rejects auth-failed PDUs when room exists', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    checkEventAuth.mockReturnValue({ allowed: false, error: 'power levels' });
    // Use a fake hash that will fail verifyContentHash — instead mock by omitting
    // verify and providing a hash that verifyContentHash rejects. Simpler: use
    // signatures but skip hash check by using legacy room version 1.
    const db = seedBasicRoom({
      rooms: [{ room_id: ROOM, room_version: '1', is_public: 1, created_at: 1 }],
    });
    const { body } = await req('PUT', '/_matrix/federation/v1/send/txn-auth', makeEnv(db), {
      pdus: [
        {
          event_id: '$authfail',
          room_id: ROOM,
          sender: REMOTE_USER,
          type: 'm.room.message',
          content: { body: 'x' },
          signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
        },
      ],
    });
    expect((body as { pdus: Record<string, { error: string }> }).pdus['$authfail'].error).toMatch(
      /power levels|authorization/i
    );
  });

  it('accepts valid legacy PDU without hash when auth allows', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    checkEventAuth.mockReturnValue({ allowed: true });
    const db = seedBasicRoom({
      rooms: [{ room_id: ROOM, room_version: '2', is_public: 1, created_at: 1 }],
    });
    const { status, body } = await req('PUT', '/_matrix/federation/v1/send/txn-ok', makeEnv(db), {
      pdus: [
        {
          event_id: '$ok2',
          room_id: ROOM,
          sender: REMOTE_USER,
          type: 'm.room.message',
          content: { body: 'hello' },
          signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
        },
      ],
      edus: [{ edu_type: 'm.typing', content: {} }],
    });
    expect(status).toBe(200);
    expect((body as { pdus: Record<string, unknown> }).pdus['$ok2']).toEqual({});
  });
});

describe('event / state / state_ids / event_auth', () => {
  it('GET event returns PDU or 404', async () => {
    const ev = makeEvent({
      event_id: '$e1:example.com',
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
      auth_events: JSON.stringify(['$create:example.com']),
      prev_events: JSON.stringify([]),
      hashes: JSON.stringify({ sha256: 'x' }),
      signatures: JSON.stringify({ [SERVER]: { 'ed25519:1': 's' } }),
    });
    const db = createFedDb({ events: [ev] });
    const ok = await req('GET', `/_matrix/federation/v1/event/${encodeURIComponent(ev.event_id)}`, makeEnv(db));
    expect(ok.status).toBe(200);
    expect((ok.body as { pdus: unknown[] }).pdus).toHaveLength(1);
    expect((ok.body as { origin: string }).origin).toBe(SERVER);

    const missing = await req('GET', '/_matrix/federation/v1/event/%24missing', makeEnv(db));
    expect(missing.status).toBe(404);
  });

  it('GET state returns pdus and auth_chain', async () => {
    const db = seedBasicRoom();
    const { status, body } = await req(
      'GET',
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}?event_id=%24e`,
      makeEnv(db)
    );
    expect(status).toBe(200);
    const b = body as { pdus: unknown[]; auth_chain: unknown[]; origin: string };
    expect(b.origin).toBe(SERVER);
    expect(b.pdus.length).toBeGreaterThan(0);
  });

  it('GET state_ids 404s unknown room and returns ids', async () => {
    const db = seedBasicRoom();
    const missing = await req('GET', '/_matrix/federation/v1/state_ids/%21no%3Aexample.com', makeEnv(db));
    expect(missing.status).toBe(404);

    const ok = await req(
      'GET',
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}`,
      makeEnv(db)
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { pdu_ids: string[] }).pdu_ids.length).toBeGreaterThan(0);

    const atEvent = await req(
      'GET',
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}?event_id=%24member%3Aexample.com`,
      makeEnv(db)
    );
    expect(atEvent.status).toBe(200);
  });

  it('GET event_auth walks auth chain and 404s missing room/event', async () => {
    const create = makeEvent({
      event_id: '$c:example.com',
      event_type: 'm.room.create',
      content: JSON.stringify({ creator: LOCAL_USER }),
      auth_events: '[]',
    });
    const child = makeEvent({
      event_id: '$child:example.com',
      event_type: 'm.room.member',
      state_key: LOCAL_USER,
      content: JSON.stringify({ membership: 'join' }),
      auth_events: JSON.stringify(['$c:example.com']),
      depth: 2,
    });
    const db = createFedDb({
      events: [create, child],
      rooms: [{ room_id: ROOM, room_version: '10' }],
    });
    const missingRoom = await req(
      'GET',
      `/_matrix/federation/v1/event_auth/%21x%3Aexample.com/${encodeURIComponent(child.event_id)}`,
      makeEnv(db)
    );
    expect(missingRoom.status).toBe(404);

    const missingEvent = await req(
      'GET',
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/%24missing`,
      makeEnv(db)
    );
    expect(missingEvent.status).toBe(404);

    const ok = await req(
      'GET',
      `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(child.event_id)}`,
      makeEnv(db)
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { auth_chain: unknown[] }).auth_chain.length).toBeGreaterThanOrEqual(1);
  });
});

describe('backfill and get_missing_events', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('backfill 404s unknown room and forbids non-members', async () => {
    const db = createFedDb({ memberships: [] });
    const missing = await req('GET', `/_matrix/federation/v1/backfill/%21no%3Ax`, makeEnv(db));
    expect(missing.status).toBe(404);

    const forbidden = await req(
      'GET',
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}`,
      makeEnv(db)
    );
    expect(forbidden.status).toBe(403);
  });

  it('backfill returns recent events and depth-filtered history', async () => {
    const events = [1, 2, 3, 4, 5].map((d) =>
      makeEvent({
        event_id: `$d${d}:example.com`,
        event_type: 'm.room.message',
        content: JSON.stringify({ body: String(d) }),
        depth: d,
      })
    );
    const db = createFedDb({
      events,
      memberships: [{ room_id: ROOM, user_id: `@m:${FED_ORIGIN}`, membership: 'join' }],
    });
    const recent = await req(
      'GET',
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=2`,
      makeEnv(db)
    );
    expect(recent.status).toBe(200);
    expect((recent.body as { pdus: unknown[] }).pdus.length).toBeLessThanOrEqual(2);

    const filtered = await req(
      'GET',
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=10&v=%24d5%3Aexample.com`,
      makeEnv(db)
    );
    expect(filtered.status).toBe(200);
    expect((filtered.body as { pdus: Array<{ depth: number }> }).pdus.every((p) => p.depth < 5)).toBe(
      true
    );
  });

  it('get_missing_events validates JSON, room, membership, and walks prev_events', async () => {
    const e1 = makeEvent({
      event_id: '$m1:example.com',
      event_type: 'm.room.message',
      content: '{}',
      depth: 1,
      prev_events: '[]',
    });
    const e2 = makeEvent({
      event_id: '$m2:example.com',
      event_type: 'm.room.message',
      content: '{}',
      depth: 2,
      prev_events: JSON.stringify(['$m1:example.com']),
    });
    const db = createFedDb({
      events: [e1, e2],
      memberships: [{ room_id: ROOM, user_id: `@m:${FED_ORIGIN}`, membership: 'join' }],
    });

    const bad = await req(
      'POST',
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      makeEnv(db),
      '{x'
    );
    expect(bad.status).toBe(400);

    const noRoom = await req(
      'POST',
      '/_matrix/federation/v1/get_missing_events/%21no%3Ax',
      makeEnv(db),
      { latest_events: ['$m2:example.com'], earliest_events: [] }
    );
    expect(noRoom.status).toBe(404);

    const noMember = await req(
      'POST',
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      makeEnv(createFedDb({ events: [e1, e2], memberships: [] })),
      { latest_events: ['$m2:example.com'] }
    );
    expect(noMember.status).toBe(403);

    const ok = await req(
      'POST',
      `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
      makeEnv(db),
      { latest_events: ['$m2:example.com'], earliest_events: [], limit: 5, min_depth: 0 }
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { events: unknown[] }).events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('make_join / send_join / make_leave / send_leave', () => {
  it('make_join 404s missing room and returns template', async () => {
    const db = seedBasicRoom();
    const missing = await req(
      'GET',
      `/_matrix/federation/v1/make_join/%21no%3Ax/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(db)
    );
    expect(missing.status).toBe(404);

    const ok = await req(
      'GET',
      `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(db)
    );
    expect(ok.status).toBe(200);
    const b = ok.body as { room_version: string; event: { type: string; content: { membership: string } } };
    expect(b.room_version).toBe('10');
    expect(b.event.type).toBe('m.room.member');
    expect(b.event.content.membership).toBe('join');
  });

  it('send_join v1 rejects bad JSON and event id mismatch', async () => {
    const db = seedBasicRoom();
    const bad = await req(
      'PUT',
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/%24j`,
      makeEnv(db),
      '{x'
    );
    expect(bad.status).toBe(400);

    const mismatch = await req(
      'PUT',
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/%24j1`,
      makeEnv(db),
      { event_id: '$other', type: 'm.room.member', content: { membership: 'join' } }
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('send_join v1 returns state and auth_chain', async () => {
    const db = seedBasicRoom();
    const { status, body } = await req(
      'PUT',
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/%24jok`,
      makeEnv(db),
      {
        event_id: '$jok',
        type: 'm.room.member',
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
        content: { membership: 'join' },
      }
    );
    expect(status).toBe(200);
    const b = body as { origin: string; state: unknown[]; auth_chain: unknown[]; event: { event_id: string } };
    expect(b.origin).toBe(SERVER);
    expect(b.state.length).toBeGreaterThan(0);
    expect(b.event.event_id).toBe('$jok');
  });

  it('send_join v2 404s missing room and returns servers_in_room', async () => {
    const db = seedBasicRoom();
    const missing = await req(
      'PUT',
      `/_matrix/federation/v2/send_join/%21no%3Ax/%24j`,
      makeEnv(db),
      { event_id: '$j', type: 'm.room.member', content: { membership: 'join' } }
    );
    expect(missing.status).toBe(404);

    const mismatch = await req(
      'PUT',
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/%24j`,
      makeEnv(db),
      { event_id: '$other' }
    );
    expect(mismatch.status).toBe(400);

    const bad = await req(
      'PUT',
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/%24j`,
      makeEnv(db),
      '{x'
    );
    expect(bad.status).toBe(400);

    const ok = await req(
      'PUT',
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/%24j2`,
      makeEnv(db),
      {
        event_id: '$j2',
        type: 'm.room.member',
        sender: REMOTE_USER,
        content: { membership: 'join' },
      }
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { servers_in_room?: string[] }).servers_in_room).toContain(SERVER);
  });

  it('make_leave forbids non-members and returns leave template', async () => {
    const db = seedBasicRoom();
    const forbidden = await req(
      'GET',
      `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(db)
    );
    expect(forbidden.status).toBe(403);

    const missing = await req(
      'GET',
      `/_matrix/federation/v1/make_leave/%21no%3Ax/${encodeURIComponent(LOCAL_USER)}`,
      makeEnv(db)
    );
    expect(missing.status).toBe(404);

    const ok = await req(
      'GET',
      `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(LOCAL_USER)}`,
      makeEnv(db)
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { event: { content: { membership: string } } }).event.content.membership).toBe(
      'leave'
    );
  });

  it('send_leave v1/v2 validate leave membership and event id', async () => {
    const db = seedBasicRoom();
    const badJson = await req(
      'PUT',
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/%24l`,
      makeEnv(db),
      '{x'
    );
    expect(badJson.status).toBe(400);

    const notLeave = await req(
      'PUT',
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/%24l`,
      makeEnv(db),
      { type: 'm.room.member', content: { membership: 'join' } }
    );
    expect(notLeave.status).toBe(400);

    const mismatch = await req(
      'PUT',
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/%24l`,
      makeEnv(db),
      { event_id: '$other', type: 'm.room.member', content: { membership: 'leave' } }
    );
    expect(mismatch.status).toBe(400);

    const ok = await req(
      'PUT',
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/%24l1`,
      makeEnv(db),
      { event_id: '$l1', type: 'm.room.member', content: { membership: 'leave' } }
    );
    expect(ok.status).toBe(200);

    const v2bad = await req(
      'PUT',
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/%24l`,
      makeEnv(db),
      '{x'
    );
    expect(v2bad.status).toBe(400);

    const v2not = await req(
      'PUT',
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/%24l`,
      makeEnv(db),
      { type: 'm.room.message', content: {} }
    );
    expect(v2not.status).toBe(400);

    const v2mis = await req(
      'PUT',
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/%24l`,
      makeEnv(db),
      { event_id: '$x', type: 'm.room.member', content: { membership: 'leave' } }
    );
    expect(v2mis.status).toBe(400);

    const v2ok = await req(
      'PUT',
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/%24l2`,
      makeEnv(db),
      { event_id: '$l2', type: 'm.room.member', content: { membership: 'leave' } }
    );
    expect(v2ok.status).toBe(200);
  });
});

describe('invite v1/v2', () => {
  let restore: (() => void) | undefined;
  let serverKeyPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    serverKeyPair = await generateSigningKeyPair();
  });
  afterAll(() => restore?.());

  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  function inviteEnv(extra: Partial<FedDbOptions> = {}) {
    return makeEnv(
      createFedDb({
        users: [{ user_id: LOCAL_USER }],
        serverKeys: [
          {
            key_id: serverKeyPair.keyId,
            public_key: serverKeyPair.publicKey,
            private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk),
            key_version: 2,
            valid_from: 1,
            valid_until: Date.now() + 100000,
            is_current: 1,
          },
        ],
        ...extra,
      })
    );
  }

  it('invite v1 validates JSON, type, origin, local user, and signs', async () => {
    const env = inviteEnv();
    const bad = await req('PUT', `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`, env, '{x');
    expect(bad.status).toBe(400);

    const notInvite = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      { type: 'm.room.member', content: { membership: 'join' }, sender: REMOTE_USER, state_key: LOCAL_USER }
    );
    expect(notInvite.status).toBe(400);

    const mismatch = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i1`,
      env,
      {
        event_id: '$other',
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      }
    );
    expect(mismatch.status).toBe(400);

    const wrongOrigin = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: '@eve:evil.example.com',
        state_key: LOCAL_USER,
      }
    );
    expect(wrongOrigin.status).toBe(403);

    const badState = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: 'bad',
      }
    );
    expect(badState.status).toBe(400);

    const remoteInvitee = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: '@x:other.com',
      }
    );
    expect(remoteInvitee.status).toBe(403);

    const missingUser = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`,
      inviteEnv({ users: [] }),
      {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      }
    );
    expect(missingUser.status).toBe(404);

    const noKey = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24i`,
      inviteEnv({ serverKeys: [] }),
      {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      }
    );
    expect(noKey.status).toBe(500);

    const ok = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/%24iok`,
      env,
      {
        event: {
          event_id: '$iok',
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      }
    );
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect((ok.body as [number, { signatures: unknown }])[0]).toBe(200);
    expect((ok.body as [number, { signatures: unknown }])[1].signatures).toBeDefined();
  });

  it('invite v2 requires room_version and returns wrapped event', async () => {
    const env = inviteEnv();
    const bad = await req('PUT', `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24i`, env, '{x');
    expect(bad.status).toBe(400);

    const noVersion = await req(
      'PUT',
      `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      {
        event: {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      }
    );
    expect(noVersion.status).toBe(400);
    expect(noVersion.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const noEvent = await req(
      'PUT',
      `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      { room_version: '10' }
    );
    expect(noEvent.status).toBe(400);

    const badVersion = await req(
      'PUT',
      `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24i`,
      env,
      {
        room_version: '99',
        event: {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      }
    );
    expect(badVersion.status).toBe(400);
    expect(badVersion.body).toMatchObject({ errcode: 'M_INCOMPATIBLE_ROOM_VERSION' });

    const ok = await req(
      'PUT',
      `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24iv2`,
      env,
      {
        room_version: '10',
        event: {
          event_id: '$iv2',
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      }
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { event: { signatures: unknown } }).event.signatures).toBeDefined();
  });
});

describe('query/directory and query/profile', () => {
  it('directory requires alias and resolves or 404s', async () => {
    const db = createFedDb({ aliases: { '#room:example.com': ROOM } });
    const missingParam = await req('GET', '/_matrix/federation/v1/query/directory', makeEnv(db));
    expect(missingParam.status).toBe(400);

    const missing = await req(
      'GET',
      '/_matrix/federation/v1/query/directory?room_alias=%23no%3Aexample.com',
      makeEnv(db)
    );
    expect(missing.status).toBe(404);

    const ok = await req(
      'GET',
      '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com',
      makeEnv(db)
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('profile requires user_id and supports field filters', async () => {
    const db = createFedDb({
      users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }],
    });
    const missing = await req('GET', '/_matrix/federation/v1/query/profile', makeEnv(db));
    expect(missing.status).toBe(400);

    const notFound = await req(
      'GET',
      '/_matrix/federation/v1/query/profile?user_id=%40no%3Aexample.com',
      makeEnv(db)
    );
    expect(notFound.status).toBe(404);

    const all = await req(
      'GET',
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(LOCAL_USER)}`,
      makeEnv(db)
    );
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ displayname: 'Alice', avatar_url: 'mxc://example.com/a' });

    const dn = await req(
      'GET',
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(LOCAL_USER)}&field=displayname`,
      makeEnv(db)
    );
    expect(dn.body).toEqual({ displayname: 'Alice' });

    const av = await req(
      'GET',
      `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(LOCAL_USER)}&field=avatar_url`,
      makeEnv(db)
    );
    expect(av.body).toEqual({ avatar_url: 'mxc://example.com/a' });
  });
});

describe('federation E2EE keys and devices', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('user/keys/query validates body and returns local device + cross-signing keys', async () => {
    const userKeys = createUserKeysStub(
      { DEVICEA: { user_id: LOCAL_USER, device_id: 'DEVICEA', algorithms: ['m.olm.v1.curve25519-aes-sha2'] } },
      { master: { keys: { 'ed25519:master': 'm' } }, self_signing: { keys: { 'ed25519:ss': 's' } } }
    );
    const db = createFedDb({
      users: [{ user_id: LOCAL_USER }],
      crossSigningSigs: [
        {
          user_id: LOCAL_USER,
          key_id: 'DEVICEA',
          signer_user_id: LOCAL_USER,
          signer_key_id: 'ed25519:master',
          signature: 'sig',
        },
      ],
    });
    const env = makeEnv(db, { userKeys });

    const bad = await req('POST', '/_matrix/federation/v1/user/keys/query', env, '{x');
    expect(bad.status).toBe(400);
    const missing = await req('POST', '/_matrix/federation/v1/user/keys/query', env, {});
    expect(missing.status).toBe(400);

    const ok = await req('POST', '/_matrix/federation/v1/user/keys/query', env, {
      device_keys: { [LOCAL_USER]: [], [REMOTE_USER]: [], '@ghost:example.com': [] },
    });
    expect(ok.status).toBe(200);
    const b = ok.body as {
      device_keys: Record<string, Record<string, { signatures?: unknown }>>;
      master_keys: Record<string, unknown>;
      self_signing_keys: Record<string, unknown>;
    };
    expect(b.device_keys[LOCAL_USER].DEVICEA).toBeDefined();
    expect(b.device_keys[LOCAL_USER].DEVICEA.signatures).toBeDefined();
    expect(b.master_keys[LOCAL_USER]).toBeDefined();
    expect(b.self_signing_keys[LOCAL_USER]).toBeDefined();
    expect(b.device_keys[REMOTE_USER]).toBeUndefined();

    const specific = await req('POST', '/_matrix/federation/v1/user/keys/query', env, {
      device_keys: { [LOCAL_USER]: ['DEVICEA', 'MISSING'] },
    });
    expect(specific.status).toBe(200);
    expect((specific.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[LOCAL_USER].DEVICEA).toBeDefined();
  });

  it('user/keys/claim validates body and claims OTKs from KV', async () => {
    const oneTimeKeys = mockKv({
      [`otk:${LOCAL_USER}:DEVICEA`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:AAAA', keyData: { key: 'otk' }, claimed: false },
        ],
      }),
    });
    const env = makeEnv(createFedDb({ users: [{ user_id: LOCAL_USER }] }), { oneTimeKeys });

    const bad = await req('POST', '/_matrix/federation/v1/user/keys/claim', env, '{x');
    expect(bad.status).toBe(400);
    const missing = await req('POST', '/_matrix/federation/v1/user/keys/claim', env, {});
    expect(missing.status).toBe(400);

    const ok = await req('POST', '/_matrix/federation/v1/user/keys/claim', env, {
      one_time_keys: {
        [LOCAL_USER]: { DEVICEA: 'signed_curve25519' },
        [REMOTE_USER]: { D: 'signed_curve25519' },
      },
    });
    expect(ok.status).toBe(200);
    const keys = (ok.body as { one_time_keys: Record<string, Record<string, unknown>> }).one_time_keys;
    expect(keys[LOCAL_USER].DEVICEA).toEqual({ 'signed_curve25519:AAAA': { key: 'otk' } });
  });

  it('user/devices forbids remote users and returns device list', async () => {
    const userKeys = createUserKeysStub(
      { DEVICEA: { algorithms: ['m.olm.v1.curve25519-aes-sha2'] } },
      { master: { keys: {} }, self_signing: { keys: {} } }
    );
    const db = createFedDb({
      users: [{ user_id: LOCAL_USER }],
      devices: [{ user_id: LOCAL_USER, device_id: 'DEVICEA', display_name: 'Phone' }],
      deviceKeyChanges: [{ user_id: LOCAL_USER, stream_position: 42 }],
    });
    const env = makeEnv(db, { userKeys });

    const remote = await req(
      'GET',
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(REMOTE_USER)}`,
      env
    );
    expect(remote.status).toBe(403);

    const missing = await req('GET', '/_matrix/federation/v1/user/devices/%40ghost%3Aexample.com', env);
    expect(missing.status).toBe(404);

    const ok = await req(
      'GET',
      `/_matrix/federation/v1/user/devices/${encodeURIComponent(LOCAL_USER)}`,
      env
    );
    expect(ok.status).toBe(200);
    const b = ok.body as {
      user_id: string;
      stream_id: number;
      devices: unknown[];
      master_key?: unknown;
      self_signing_key?: unknown;
    };
    expect(b.user_id).toBe(LOCAL_USER);
    expect(b.stream_id).toBe(42);
    expect(b.devices).toHaveLength(1);
    expect(b.master_key).toBeDefined();
    expect(b.self_signing_key).toBeDefined();
  });
});

describe('knock protocol', () => {
  it('make_knock validates room and join_rules', async () => {
    const missing = await req(
      'GET',
      `/_matrix/federation/v1/make_knock/%21no%3Ax/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(createFedDb({ rooms: [] }))
    );
    expect(missing.status).toBe(404);

    const publicRoom = seedBasicRoom();
    const forbidden = await req(
      'GET',
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(publicRoom)
    );
    expect(forbidden.status).toBe(403);

    const noJr = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10' }],
      events: [],
      roomState: new Map(),
    });
    const defaultForbidden = await req(
      'GET',
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(noJr)
    );
    expect(defaultForbidden.status).toBe(403);

    const knockJr = makeEvent({
      event_id: '$kjr:example.com',
      event_type: 'm.room.join_rules',
      content: JSON.stringify({ join_rule: 'knock' }),
    });
    const create = makeEvent({
      event_id: '$kc:example.com',
      event_type: 'm.room.create',
      content: '{}',
    });
    const pl = makeEvent({
      event_id: '$kpl:example.com',
      event_type: 'm.room.power_levels',
      content: '{}',
    });
    const knockDb = createFedDb({
      events: [knockJr, create, pl],
      roomState: new Map([
        [stateKey(ROOM, 'm.room.join_rules', ''), knockJr.event_id],
        [stateKey(ROOM, 'm.room.create', ''), create.event_id],
        [stateKey(ROOM, 'm.room.power_levels', ''), pl.event_id],
      ]),
    });
    const ok = await req(
      'GET',
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}`,
      makeEnv(knockDb)
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { event: { content: { membership: string } } }).event.content.membership).toBe(
      'knock'
    );
  });

  it('send_knock validates JSON, type, room, bans, and stores knock', async () => {
    const knockJr = makeEvent({
      event_id: '$kjr2:example.com',
      event_type: 'm.room.join_rules',
      content: JSON.stringify({ join_rule: 'knock_restricted' }),
    });
    const db = seedBasicRoom();
    db.roomState.set(stateKey(ROOM, 'm.room.join_rules', ''), knockJr.event_id);
    db.events.set(knockJr.event_id, knockJr);

    const bad = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24k`,
      makeEnv(db),
      '{x'
    );
    expect(bad.status).toBe(400);

    const notKnock = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24k`,
      makeEnv(db),
      { type: 'm.room.member', content: { membership: 'join' } }
    );
    expect(notKnock.status).toBe(400);

    const mismatch = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24k1`,
      makeEnv(db),
      {
        event_id: '$other',
        type: 'm.room.member',
        content: { membership: 'knock' },
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
      }
    );
    expect(mismatch.status).toBe(400);

    const noRoom = await req(
      'PUT',
      '/_matrix/federation/v1/send_knock/%21no%3Ax/%24k',
      makeEnv(db),
      {
        event_id: '$k',
        type: 'm.room.member',
        content: { membership: 'knock' },
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
      }
    );
    expect(noRoom.status).toBe(404);

    const publicDb = seedBasicRoom();
    const forbidden = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24k`,
      makeEnv(publicDb),
      {
        event_id: '$k',
        type: 'm.room.member',
        content: { membership: 'knock' },
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
      }
    );
    expect(forbidden.status).toBe(403);

    const banned = seedBasicRoom({
      memberships: [{ room_id: ROOM, user_id: REMOTE_USER, membership: 'ban' }],
    });
    banned.roomState.set(stateKey(ROOM, 'm.room.join_rules', ''), knockJr.event_id);
    banned.events.set(knockJr.event_id, knockJr);
    const banRes = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24kban`,
      makeEnv(banned),
      {
        event_id: '$kban',
        type: 'm.room.member',
        content: { membership: 'knock' },
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
        origin_server_ts: 1,
        depth: 10,
      }
    );
    expect(banRes.status).toBe(403);

    const already = seedBasicRoom({
      memberships: [{ room_id: ROOM, user_id: REMOTE_USER, membership: 'join' }],
    });
    already.roomState.set(stateKey(ROOM, 'm.room.join_rules', ''), knockJr.event_id);
    already.events.set(knockJr.event_id, knockJr);
    const joinRes = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24kjoin`,
      makeEnv(already),
      {
        event_id: '$kjoin',
        type: 'm.room.member',
        content: { membership: 'knock' },
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
      }
    );
    expect(joinRes.status).toBe(403);

    const ok = await req(
      'PUT',
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/%24kok`,
      makeEnv(db),
      {
        event_id: '$kok',
        type: 'm.room.member',
        content: { membership: 'knock' },
        sender: REMOTE_USER,
        state_key: REMOTE_USER,
        origin_server_ts: 123,
        depth: 9,
        auth_events: [],
        prev_events: [],
      }
    );
    expect(ok.status).toBe(200);
    expect(db.events.has('$kok')).toBe(true);
  });
});

describe('publicRooms GET/POST', () => {
  it('lists public rooms with pagination tokens', async () => {
    const rooms = [
      { room_id: '!a:example.com', room_version: '10', is_public: 1, created_at: 300 },
      { room_id: '!b:example.com', room_version: '10', is_public: 1, created_at: 200 },
      { room_id: '!c:example.com', room_version: '10', is_public: 1, created_at: 100 },
      { room_id: '!priv:example.com', room_version: '10', is_public: 0, created_at: 400 },
    ];
    const nameA = makeEvent({
      event_id: '$na',
      room_id: '!a:example.com',
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'Alpha' }),
    });
    const db = createFedDb({
      rooms,
      events: [nameA],
      roomState: new Map([[stateKey('!a:example.com', 'm.room.name', ''), '$na']]),
    });

    const all = await req('GET', '/_matrix/federation/v1/publicRooms?limit=2', makeEnv(db));
    expect(all.status).toBe(200);
    const b = all.body as { chunk: unknown[]; next_batch?: string; total_room_count_estimate: number };
    expect(b.chunk.length).toBe(2);
    expect(b.next_batch).toBe('offset_2');
    expect(b.total_room_count_estimate).toBe(3);

    const page2 = await req(
      'GET',
      '/_matrix/federation/v1/publicRooms?limit=2&since=offset_2',
      makeEnv(db)
    );
    expect(page2.status).toBe(200);
    expect((page2.body as { prev_batch?: string }).prev_batch).toBe('offset_0');
  });

  it('POST publicRooms searches and rejects bad JSON', async () => {
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      events: [
        makeEvent({
          event_id: '$n',
          event_type: 'm.room.name',
          content: JSON.stringify({ name: 'Searchable' }),
        }),
      ],
      roomState: new Map([[stateKey(ROOM, 'm.room.name', ''), '$n']]),
    });
    const bad = await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), '{x');
    expect(bad.status).toBe(400);

    const empty = await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10 });
    expect(empty.status).toBe(200);

    const search = await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), {
      limit: 10,
      filter: { generic_search_term: 'search' },
      since: 'offset_0',
    });
    expect(search.status).toBe(200);
  });
});

describe('hierarchy and timestamp_to_event', () => {
  it('hierarchy 404s and returns space + children', async () => {
    const childRoom = '!child:example.com';
    const childEvt = makeEvent({
      event_id: '$childlink',
      event_type: 'm.space.child',
      state_key: childRoom,
      content: JSON.stringify({ via: [SERVER], suggested: true }),
    });
    const name = makeEvent({
      event_id: '$spname',
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'Space' }),
    });
    const childName = makeEvent({
      event_id: '$cname',
      room_id: childRoom,
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'Child' }),
    });
    const db = createFedDb({
      rooms: [
        { room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 },
        { room_id: childRoom, room_version: '10', is_public: 1, created_at: 2 },
      ],
      events: [childEvt, name, childName],
      roomState: new Map([
        [stateKey(ROOM, 'm.space.child', childRoom), childEvt.event_id],
        [stateKey(ROOM, 'm.room.name', ''), name.event_id],
        [stateKey(childRoom, 'm.room.name', ''), childName.event_id],
      ]),
    });

    const missing = await req('GET', '/_matrix/federation/v1/hierarchy/%21no%3Ax', makeEnv(db));
    expect(missing.status).toBe(404);

    const ok = await req(
      'GET',
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?suggested_only=true&limit=10`,
      makeEnv(db)
    );
    expect(ok.status).toBe(200);
    const hier = ok.body as { room: { room_id: string } | null; children: unknown[] };
    expect(hier.room?.room_id).toBe(ROOM);
    expect(hier.children.length).toBeGreaterThanOrEqual(1);

    const page = await req(
      'GET',
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?from=offset_0`,
      makeEnv(db)
    );
    expect(page.status).toBe(200);
  });

  it('timestamp_to_event requires ts and finds nearest event', async () => {
    const e1 = makeEvent({
      event_id: '$t1',
      event_type: 'm.room.message',
      content: '{}',
      origin_server_ts: 1000,
    });
    const e2 = makeEvent({
      event_id: '$t2',
      event_type: 'm.room.message',
      content: '{}',
      origin_server_ts: 2000,
      depth: 2,
    });
    const db = createFedDb({ events: [e1, e2] });

    const missingTs = await req(
      'GET',
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}`,
      makeEnv(db)
    );
    expect(missingTs.status).toBe(400);

    const noRoom = await req(
      'GET',
      '/_matrix/federation/v1/timestamp_to_event/%21no%3Ax?ts=1500',
      makeEnv(db)
    );
    expect(noRoom.status).toBe(404);

    const forward = await req(
      'GET',
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=1500&dir=f`,
      makeEnv(db)
    );
    expect(forward.status).toBe(200);
    expect((forward.body as { event_id: string }).event_id).toBe('$t2');

    const backward = await req(
      'GET',
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=1500&dir=b`,
      makeEnv(db)
    );
    expect(backward.status).toBe(200);
    expect((backward.body as { event_id: string }).event_id).toBe('$t1');

    const none = await req(
      'GET',
      `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=50&dir=b`,
      makeEnv(db)
    );
    expect(none.status).toBe(404);
  });
});

describe('openid/userinfo', () => {
  it('validates access_token and expiry', async () => {
    const sessions = mockKv({
      'openid:good': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60_000 }),
      'openid:expired': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() - 1000 }),
    });
    const env = makeEnv(createFedDb(), { sessions });

    const missing = await req('GET', '/_matrix/federation/v1/openid/userinfo', env);
    expect(missing.status).toBe(400);

    const unknown = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=nope', env);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });

    const expired = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=expired', env);
    expect(expired.status).toBe(401);
    expect(sessions.data['openid:expired']).toBeUndefined();

    const ok = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=good', env);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ sub: LOCAL_USER });
  });
});

describe('additional send / query / claim edges', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    getRoomState.mockResolvedValue({});
  });

  it('send rejects third-party PDU signature failures with distinct reason', async () => {
    verifyRemoteSignature.mockResolvedValue(false);
    const db = seedBasicRoom();
    const { body } = await req('PUT', '/_matrix/federation/v1/send/txn-3p', makeEnv(db), {
      pdus: [
        {
          event_id: '$3p',
          room_id: ROOM,
          sender: '@carol:other.example.com',
          type: 'm.room.message',
          content: { body: 'x' },
          hashes: { sha256: 'abc' },
          signatures: { 'other.example.com': { 'ed25519:1': 'sig' } },
        },
      ],
    });
    expect((body as { pdus: Record<string, { error: string }> }).pdus['$3p'].error).toMatch(
      /Third-party/
    );
  });

  it('send rejects unknown-room PDUs missing hash under strict default', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    const db = createFedDb({ rooms: [] });
    const { body } = await req('PUT', '/_matrix/federation/v1/send/txn-unk', makeEnv(db), {
      pdus: [
        {
          event_id: '$unk',
          room_id: '!unknown:example.com',
          sender: REMOTE_USER,
          type: 'm.room.message',
          content: { body: 'x' },
          signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
        },
      ],
    });
    expect((body as { pdus: Record<string, { error: string }> }).pdus['$unk'].error).toMatch(
      /Missing required hashes/
    );
  });

  it('send caches empty PDU transaction response', async () => {
    const db = createFedDb();
    const first = await req('PUT', '/_matrix/federation/v1/send/txn-empty', makeEnv(db), { pdus: [] });
    expect(first.status).toBe(200);
    expect(db.federationTxns[`${FED_ORIGIN}|txn-empty`]).toBeDefined();
    const second = await req('PUT', '/_matrix/federation/v1/send/txn-empty', makeEnv(db), {
      pdus: [{ event_id: '$should-not-run', room_id: ROOM }],
    });
    expect(second.body).toEqual(first.body);
  });

  it('claim falls back to D1 one_time_keys and fallback_keys', async () => {
    const fallbacks = new Map<string, { key_id: string; key_data: string; used: number }>();
    fallbacks.set(`${LOCAL_USER}|DEVICEC|signed_curve25519`, {
      key_id: 'signed_curve25519:FALL',
      key_data: JSON.stringify({ key: 'fb' }),
      used: 0,
    });

    const base = createFedDb({ users: [{ user_id: LOCAL_USER }] });
    const origPrepare = base.prepare.bind(base);
    base.prepare = ((sql: string) => {
      if (sql.includes('FROM one_time_keys') && sql.includes('claimed = 0')) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                const [userId, deviceId] = args as [string, string];
                if (userId === LOCAL_USER && deviceId === 'DEVICEB') {
                  return {
                    id: 1,
                    key_id: 'signed_curve25519:BBB',
                    key_data: JSON.stringify({ key: 'd1' }),
                  } as T;
                }
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      }
      if (sql.includes('UPDATE one_time_keys SET claimed = 1')) {
        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      }
      if (sql.includes('FROM fallback_keys')) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const row = fallbacks.get(`${userId}|${deviceId}|${algorithm}`);
                return (row ?? null) as T;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      }
      if (sql.includes('UPDATE fallback_keys SET used = 1')) {
        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      }
      return origPrepare(sql);
    }) as typeof base.prepare;

    const env = makeEnv(base, { oneTimeKeys: mockKv() });
    const d1 = await req('POST', '/_matrix/federation/v1/user/keys/claim', env, {
      one_time_keys: { [LOCAL_USER]: { DEVICEB: 'signed_curve25519' } },
    });
    expect(d1.status).toBe(200);
    expect(
      (d1.body as { one_time_keys: Record<string, Record<string, unknown>> }).one_time_keys[
        LOCAL_USER
      ].DEVICEB
    ).toEqual({ 'signed_curve25519:BBB': { key: 'd1' } });

    const fb = await req('POST', '/_matrix/federation/v1/user/keys/claim', env, {
      one_time_keys: { [LOCAL_USER]: { DEVICEC: 'signed_curve25519' } },
    });
    expect(fb.status).toBe(200);
    expect(
      (fb.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
        .one_time_keys[LOCAL_USER].DEVICEC['signed_curve25519:FALL']
    ).toMatchObject({ key: 'fb', fallback: true });
  });

  it('GET key/v2/server/:keyId uses valid_until fallback when null', async () => {
    const restore = installNodeEd25519Shim();
    try {
      const kp = await generateSigningKeyPair();
      const db = createFedDb({
        serverKeys: [
          {
            key_id: kp.keyId,
            public_key: kp.publicKey,
            private_key_jwk: JSON.stringify(kp.privateKeyJwk),
            key_version: 2,
            valid_from: 1,
            valid_until: null,
            is_current: 1,
          },
        ],
      });
      const { status, body } = await req(
        'GET',
        `/_matrix/key/v2/server/${encodeURIComponent(kp.keyId)}`,
        makeEnv(db)
      );
      expect(status).toBe(200);
      expect((body as { valid_until_ts: number }).valid_until_ts).toBeGreaterThan(Date.now());
    } finally {
      restore();
    }
  });

  it('backfill without origin membership check when federationOrigin unset', async () => {
    federationOrigin = undefined;
    const events = [
      makeEvent({
        event_id: '$b1',
        event_type: 'm.room.message',
        content: '{}',
        depth: 1,
      }),
    ];
    const db = createFedDb({ events, memberships: [] });
    const { status, body } = await req(
      'GET',
      `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=5`,
      makeEnv(db)
    );
    expect(status).toBe(200);
    expect((body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('hierarchy skips deleted children (empty via) and non-suggested when filtered', async () => {
    const deleted = makeEvent({
      event_id: '$del',
      event_type: 'm.space.child',
      state_key: '!gone:example.com',
      content: JSON.stringify({ via: [] }),
    });
    const unsuggested = makeEvent({
      event_id: '$uns',
      event_type: 'm.space.child',
      state_key: '!plain:example.com',
      content: JSON.stringify({ via: [SERVER], suggested: false }),
    });
    const name = makeEvent({
      event_id: '$hn',
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'Space' }),
    });
    const db = createFedDb({
      rooms: [
        { room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 },
        { room_id: '!plain:example.com', room_version: '10', is_public: 1, created_at: 2 },
      ],
      events: [deleted, unsuggested, name],
      roomState: new Map([
        [stateKey(ROOM, 'm.space.child', '!gone:example.com'), deleted.event_id],
        [stateKey(ROOM, 'm.space.child', '!plain:example.com'), unsuggested.event_id],
        [stateKey(ROOM, 'm.room.name', ''), name.event_id],
      ]),
    });
    const { status, body } = await req(
      'GET',
      `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?suggested_only=true`,
      makeEnv(db)
    );
    expect(status).toBe(200);
    expect((body as { children: unknown[] }).children).toHaveLength(0);
  });
});

describe('federation route method probes', () => {
  it('rejects wrong methods on key endpoints with 404/405', async () => {
    const env = makeEnv(createFedDb());
    const r1 = await req('DELETE', '/_matrix/federation/v1/version', env);
    expect([404, 405]).toContain(r1.status);
    const r2 = await req('POST', '/_matrix/key/v2/server', env);
    expect([404, 405]).toContain(r2.status);
    const r3 = await req('GET', '/_matrix/federation/v1/publicRooms', env);
    expect(r3.status).toBe(200);
  });
});

afterEach(() => {
  federationOrigin = FED_ORIGIN;
  vi.clearAllMocks();
});
