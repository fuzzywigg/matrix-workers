/**
 * TOKENMAXX HEAVY leftovers after #214 / deepen after #232 / residual after #241
 * — federation-api *concurrent race / TOCTOU* for leftover S2S routes that
 * only had serial soft floods (#157 leftover). Distinct from
 * federation-keys-membership-account-data concurrent-race (OTK / make_join)
 * and federation-api-route-leftovers (serial floods). Distinct from tip #241
 * (devices+keybackups) and #239 (this file's prior deepen).
 *
 * Residual after #241: hierarchy∥timestamp∥backfill triple; thumbnail∥download;
 * event_auth∥get_missing isolation; version∥publicRooms — soft-flooded in
 * route leftovers deepen but not additional Promise.all races after #239.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
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

import federation from '../src/api/federation';
import { generateSigningKeyPair } from '../src/utils/crypto';

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
const ALIAS = '#room:example.com';

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

describe('race federation GET version coherency after #214', () => {
  it('dual GET version same SERVER_VERSION', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/version', env),
      req('GET', '/_matrix/federation/v1/version', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect((r.body as { server: { name: string; version: string } }).server.name).toBe('matrix-worker');
      expect((r.body as { server: { name: string; version: string } }).server.version).toBe('test-0.1.0');
    }
  });

  it('missing SERVER_VERSION falls back to 0.1.0 under race', async () => {
    const env = makeEnv(createFedDb());
    delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/version', env),
      req('GET', '/_matrix/federation/v1/version', env),
      req('GET', '/_matrix/federation/v1/version', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(
      results.every(
        (r) => (r.body as { server: { version: string } }).server.version === '0.1.0'
      )
    ).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`version flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      (env as { SERVER_VERSION?: string }).SERVER_VERSION = `v-${i}`;
      const results = await Promise.all(
        [0, 1, 2].map(() => req('GET', '/_matrix/federation/v1/version', env))
      );
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(
        results.every((r) => (r.body as { server: { version: string } }).server.version === `v-${i}`)
      ).toBe(true);
    });
  }
});

describe('race federation publicRooms GET∥POST after #214', () => {
  it('parallel GET publicRooms same chunk estimate', async () => {
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }],
    });
    const env = makeEnv(db);
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env),
      req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body).toHaveProperty('chunk');
      expect((r.body as { total_room_count_estimate: number }).total_room_count_estimate).toBe(1);
    }
  });

  it('GET∥POST publicRooms isolation', async () => {
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }],
    });
    const env = makeEnv(db);
    const [g, p] = await Promise.all([
      req('GET', '/_matrix/federation/v1/publicRooms?limit=10', env),
      req('POST', '/_matrix/federation/v1/publicRooms', env, { limit: 10, filter: { generic_search_term: 'Public' } }),
    ]);
    expect(g.status).toBe(200);
    expect(p.status).toBe(200);
    expect(g.body).toHaveProperty('chunk');
    expect(p.body).toHaveProperty('chunk');
  });

  for (let i = 0; i < 10; i++) {
    it(`publicRooms GET∥POST flood-${i}`, async () => {
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - i }],
      });
      const env = makeEnv(db);
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/publicRooms?limit=${(i % 5) + 1}`, env),
        req('POST', '/_matrix/federation/v1/publicRooms', env, {
          limit: (i % 5) + 1,
          filter: { generic_search_term: i % 2 === 0 ? 'room' : '' },
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race federation query directory∥profile after #214', () => {
  it('parallel directory same alias', async () => {
    const db = createFedDb({ aliases: { [ALIAS]: ROOM } });
    const env = makeEnv(db);
    const path = `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(ALIAS)}`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect((r.body as { room_id: string }).room_id).toBe(ROOM);
      expect((r.body as { servers: string[] }).servers).toEqual([SERVER]);
    }
  });

  it('directory missing∥profile missing isolation', async () => {
    const db = createFedDb();
    const env = makeEnv(db);
    const [dir, prof] = await Promise.all([
      req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23missing%3Aexample.com', env),
      req('GET', '/_matrix/federation/v1/query/profile?user_id=%40missing%3Aexample.com', env),
    ]);
    expect(dir.status).toBe(404);
    expect(prof.status).toBe(404);
  });

  it('profile field variants parallel', async () => {
    const env = makeEnv(createFedDb());
    const base = `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(LOCAL_USER)}`;
    const [all, dn, av] = await Promise.all([
      req('GET', base, env),
      req('GET', `${base}&field=displayname`, env),
      req('GET', `${base}&field=avatar_url`, env),
    ]);
    expect(statusesOf([all, dn, av])).toEqual([200, 200, 200]);
    expect((dn.body as { displayname: string }).displayname).toBe('Alice');
    expect((av.body as { avatar_url: string }).avatar_url).toBe('mxc://example.com/a');
    expect(all.body).toHaveProperty('displayname');
    expect(all.body).toHaveProperty('avatar_url');
  });

  for (let i = 0; i < 10; i++) {
    it(`directory∥profile flood-${i}`, async () => {
      const db = createFedDb({ aliases: { [ALIAS]: ROOM } });
      const env = makeEnv(db);
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(ALIAS)}`, env),
        req('GET', `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(LOCAL_USER)}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race federation openid SESSIONS get barrier after #214', () => {
  it('parallel userinfo same token both sub', async () => {
    const sessions = mockKv(
      {
        'openid:tok': JSON.stringify({
          user_id: LOCAL_USER,
          expires_at: Date.now() + 60_000,
        }),
      },
      { getBarrier: { count: 2, match: (key) => key === 'openid:tok' } }
    );
    const env = makeEnv(createFedDb(), { sessions });
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { sub: string }).sub === LOCAL_USER)).toBe(true);
  });

  it('expire mid-flight: first GET sees token; later GET 401 after mutate', async () => {
    const sessions = mockKv(
      {
        'openid:tok': JSON.stringify({
          user_id: LOCAL_USER,
          expires_at: Date.now() + 60_000,
        }),
      },
      {
        getBarrier: { count: 2, match: (key) => key === 'openid:tok' },
        mutateAfterGets: {
          after: 1,
          next: {
            'openid:tok': JSON.stringify({
              user_id: LOCAL_USER,
              expires_at: Date.now() - 1,
            }),
          },
        },
      }
    );
    const env = makeEnv(createFedDb(), { sessions });
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok', env),
    ]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(401);
  });

  it('missing token param concurrent 400', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo', env),
    ]);
    expect(statusesOf(results)).toEqual([400, 400]);
  });

  for (let i = 0; i < 8; i++) {
    it(`openid unknown token flood-${i}`, async () => {
      const env = makeEnv(createFedDb(), { sessions: mockKv() });
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=missing-${i}`, env),
        req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=missing-${i}`, env),
      ]);
      expect(statusesOf(results)).toEqual([401, 401]);
    });
  }
});

describe('race federation media download R2 get barrier after #214', () => {
  it('parallel download same object both 200', async () => {
    const media = mockR2(
      { [MEDIA_ID]: new Uint8Array([1, 2, 3, 4]) },
      { getBarrier: { count: 2, match: (key) => key === MEDIA_ID } }
    );
    const db = createFedDb({
      media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'pic.png' }],
    });
    const env = makeEnv(db, { media });
    const results = await Promise.all([
      req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
      req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].headers.get('Content-Type')).toBe('image/png');
  });

  it('missing media parallel 404', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/media/download/nope', env),
      req('GET', '/_matrix/federation/v1/media/download/nope', env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  for (let i = 0; i < 8; i++) {
    it(`media download flood-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([i, i + 1]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: `p${i}.png` }],
      });
      const env = makeEnv(db, { media });
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race federation send txn cache TOCTOU after #214', () => {
  it('same txnId dual PUT both miss cache then both 200 empty pdus', async () => {
    const db = createFedDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT response FROM federation_transactions'),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const results = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-race', env, { pdus: [] }),
      req('PUT', '/_matrix/federation/v1/send/txn-race', env, { pdus: [] }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { pdus: unknown }).pdus)).toBeTruthy();
    expect(db.federationTxns[`${FED_ORIGIN}|txn-race`]).toBeDefined();
  });

  it('distinct txnIds parallel insert two cached responses', async () => {
    const db = createFedDb();
    const env = makeEnv(db);
    const results = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-a', env, { pdus: [] }),
      req('PUT', '/_matrix/federation/v1/send/txn-b', env, { pdus: [] }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.federationTxns[`${FED_ORIGIN}|txn-a`]).toBeDefined();
    expect(db.federationTxns[`${FED_ORIGIN}|txn-b`]).toBeDefined();
  });

  it('cached txn replay parallel returns stored body', async () => {
    const cached = JSON.stringify({ pdus: { cached: true } });
    const db = createFedDb({
      federationTxns: { [`${FED_ORIGIN}|cached`]: cached },
      selectBarrier: {
        match: (sql) => sql.includes('SELECT response FROM federation_transactions'),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const results = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/cached', env, { pdus: [{ event_id: '$x' }] }),
      req('PUT', '/_matrix/federation/v1/send/cached', env, { pdus: [{ event_id: '$y' }] }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { pdus: { cached: boolean } }).pdus.cached === true)).toBe(
      true
    );
  });

  it('send without origin 401 under race', async () => {
    federationOrigin = undefined;
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/x', env, { pdus: [] }),
      req('PUT', '/_matrix/federation/v1/send/x', env, { pdus: [] }),
    ]);
    expect(statusesOf(results)).toEqual([401, 401]);
  });

  for (let i = 0; i < 8; i++) {
    it(`send empty pdus flood-${i}`, async () => {
      const db = createFedDb();
      const env = makeEnv(db);
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/flood-${i}-a`, env, { pdus: [], edus: [] }),
        req('PUT', `/_matrix/federation/v1/send/flood-${i}-b`, env, { pdus: [] }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race federation key/v2/server after #214', () => {
  let restore: (() => void) | undefined;
  let serverKeyPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    serverKeyPair = await generateSigningKeyPair();
  });
  afterAll(() => restore?.());

  it('seeded keys parallel GET same server_name + verify_keys', async () => {
    const db = createFedDb({
      serverKeys: [
        {
          key_id: serverKeyPair.keyId,
          public_key: serverKeyPair.publicKey,
          private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk),
          key_version: 2,
          valid_from: Date.now() - 1000,
          valid_until: Date.now() + 86400000,
          is_current: 1,
        },
      ],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM server_keys') &&
          sql.includes('is_current = 1') &&
          sql.includes('ORDER BY key_version DESC'),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const results = await Promise.all([
      req('GET', '/_matrix/key/v2/server', env),
      req('GET', '/_matrix/key/v2/server', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect((r.body as { server_name: string }).server_name).toBe(SERVER);
      expect((r.body as { verify_keys: Record<string, unknown> }).verify_keys).toHaveProperty(
        serverKeyPair.keyId
      );
    }
  });

  it('empty server_keys parallel mint both 200', async () => {
    const db = createFedDb({
      serverKeys: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM server_keys') &&
          sql.includes('is_current = 1') &&
          sql.includes('ORDER BY key_version DESC'),
        count: 2,
      },
    });
    const env = makeEnv(db);
    const results = await Promise.all([
      req('GET', '/_matrix/key/v2/server', env),
      req('GET', '/_matrix/key/v2/server', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => (r.body as { server_name: string }).server_name === SERVER)).toBe(
      true
    );
    expect(
      results.every(
        (r) => Object.keys((r.body as { verify_keys: Record<string, unknown> }).verify_keys).length > 0
      )
    ).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`key/v2/server seeded flood-${i}`, async () => {
      const db = createFedDb({
        serverKeys: [
          {
            key_id: serverKeyPair.keyId,
            public_key: serverKeyPair.publicKey,
            private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk),
            key_version: 2,
            valid_from: Date.now() - 1000,
            valid_until: Date.now() + 86400000,
            is_current: 1,
          },
        ],
      });
      const r = await Promise.all([
        req('GET', '/_matrix/key/v2/server', makeEnv(db)),
        req('GET', '/_matrix/key/v2/server', makeEnv(db)),
      ]);
      expect(statusesOf(r)).toEqual([200, 200]);
    });
  }
});

describe('race federation state∥event leftover GETs after #214', () => {
  it('state∥state_ids parallel', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const roomEnc = encodeURIComponent(ROOM);
    const [state, ids] = await Promise.all([
      req('GET', `/_matrix/federation/v1/state/${roomEnc}`, env),
      req('GET', `/_matrix/federation/v1/state_ids/${roomEnc}`, env),
    ]);
    expect(state.status).toBe(200);
    expect(ids.status).toBe(200);
    expect(state.body).toHaveProperty('pdus');
    expect(ids.body).toHaveProperty('pdu_ids');
  });

  it('event GET dual', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/event/%24create%3Aexample.com', env),
      req('GET', '/_matrix/federation/v1/event/%24create%3Aexample.com', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('missing event∥missing state_ids isolation', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const [ev, st] = await Promise.all([
      req('GET', '/_matrix/federation/v1/event/%24nope', env),
      req('GET', '/_matrix/federation/v1/state_ids/%21n%3Ax', env),
    ]);
    expect(ev.status).toBe(404);
    expect([200, 404]).toContain(st.status);
  });

  for (let i = 0; i < 8; i++) {
    it(`state flood-${i}`, async () => {
      const env = makeEnv(seedBasicRoom());
      const roomEnc = encodeURIComponent(ROOM);
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/state/${roomEnc}`, env),
        req('GET', `/_matrix/federation/v1/state_ids/${roomEnc}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race federation leftover isolation + method matrix after #214', () => {
  it('version∥publicRooms∥directory concurrent isolation', async () => {
    const db = createFedDb({
      aliases: { [ALIAS]: ROOM },
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }],
    });
    const env = makeEnv(db);
    const [ver, pub, dir] = await Promise.all([
      req('GET', '/_matrix/federation/v1/version', env),
      req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env),
      req('GET', `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(ALIAS)}`, env),
    ]);
    expect(ver.status).toBe(200);
    expect(pub.status).toBe(200);
    expect(dir.status).toBe(200);
    expect((ver.body as { server: { name: string } }).server.name).toBe('matrix-worker');
    expect((dir.body as { room_id: string }).room_id).toBe(ROOM);
    expect(pub.body).toHaveProperty('chunk');
  });

  it('wrong methods on leftover GET paths', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('POST', '/_matrix/federation/v1/version', env, {}),
      req('PUT', '/_matrix/federation/v1/version', env, {}),
      req('DELETE', '/_matrix/federation/v1/version', env),
      req('PATCH', '/_matrix/federation/v1/query/directory', env, {}),
      req('DELETE', '/_matrix/federation/v1/query/profile', env),
    ]);
    expect(results.every((r) => [404, 405].includes(r.status))).toBe(true);
  });

  it('directory empty alias∥profile missing param concurrent 400', async () => {
    const env = makeEnv(createFedDb());
    const [dir, prof] = await Promise.all([
      req('GET', '/_matrix/federation/v1/query/directory?room_alias=', env),
      req('GET', '/_matrix/federation/v1/query/profile', env),
    ]);
    expect(dir.status).toBe(400);
    expect(prof.status).toBe(400);
  });

  for (let i = 0; i < 8; i++) {
    it(`isolation flood-${i}`, async () => {
      const env = makeEnv(
        createFedDb({
          aliases: { [ALIAS]: ROOM },
          rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
        })
      );
      const results = await Promise.all([
        req('GET', '/_matrix/federation/v1/version', env),
        req('GET', `/_matrix/federation/v1/query/profile?user_id=${encodeURIComponent(LOCAL_USER)}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

// ---------------------------------------------------------------------------
// After #232: leftover S2S TOCTOU — keyId / notary / thumbnail / event_auth /
// backfill / timestamp / hierarchy / send isolation / openid expired
// ---------------------------------------------------------------------------

describe('race leftover key/v2/server/:keyId + notary query after #232', () => {
  let restore: (() => void) | undefined;
  let serverKeyPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

  beforeAll(async () => {
    restore = installNodeEd25519Shim();
    serverKeyPair = await generateSigningKeyPair();
  });
  afterAll(() => restore?.());

  function seededKeysDb() {
    return createFedDb({
      serverKeys: [
        {
          key_id: serverKeyPair.keyId,
          public_key: serverKeyPair.publicKey,
          private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk),
          key_version: 2,
          valid_from: Date.now() - 1000,
          valid_until: Date.now() + 86400000,
          is_current: 1,
        },
      ],
    });
  }

  it('parallel GET /key/v2/server/:keyId same verify_keys', async () => {
    const db = seededKeysDb();
    const env = makeEnv(db);
    const path = `/_matrix/key/v2/server/${encodeURIComponent(serverKeyPair.keyId)}`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect((r.body as { server_name: string }).server_name).toBe(SERVER);
      expect((r.body as { verify_keys: Record<string, unknown> }).verify_keys).toHaveProperty(
        serverKeyPair.keyId
      );
    }
  });

  it('missing keyId∥seeded keyId isolation', async () => {
    const env = makeEnv(seededKeysDb());
    const [miss, hit] = await Promise.all([
      req('GET', '/_matrix/key/v2/server/ed25519:nope', env),
      req('GET', `/_matrix/key/v2/server/${encodeURIComponent(serverKeyPair.keyId)}`, env),
    ]);
    expect(miss.status).toBe(404);
    expect(hit.status).toBe(200);
  });

  it('POST key/v2/query own-server dual 200', async () => {
    getRemoteKeysWithNotarySignature.mockResolvedValue([]);
    const env = makeEnv(seededKeysDb());
    const results = await Promise.all([
      req('POST', '/_matrix/key/v2/query', env, { server_keys: { [SERVER]: { '': {} } } }),
      req('POST', '/_matrix/key/v2/query', env, { server_keys: { [SERVER]: { '': {} } } }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(
      results.every((r) =>
        (r.body as { server_keys: Array<{ server_name: string }> }).server_keys.some(
          (k) => k.server_name === SERVER
        )
      )
    ).toBe(true);
  });

  it('GET key/v2/query own-server∥invalid hostname isolation', async () => {
    const env = makeEnv(seededKeysDb());
    const [own, invalid] = await Promise.all([
      req('GET', `/_matrix/key/v2/query/${SERVER}`, env),
      req('GET', '/_matrix/key/v2/query/127.0.0.1', env),
    ]);
    expect(own.status).toBe(200);
    expect(invalid.status).toBe(400);
  });

  it('POST query missing server_keys∥empty notary 500 isolation', async () => {
    const [missing, empty] = await Promise.all([
      req('POST', '/_matrix/key/v2/query', makeEnv(seededKeysDb()), {}),
      req('POST', '/_matrix/key/v2/query', makeEnv(createFedDb({ serverKeys: [] })), {
        server_keys: { [SERVER]: { '': {} } },
      }),
    ]);
    expect(missing.status).toBe(400);
    expect(empty.status).toBe(500);
  });

  for (let i = 0; i < 8; i++) {
    it(`keyId leftover flood-${i}`, async () => {
      const env = makeEnv(seededKeysDb());
      const results = await Promise.all([
        req('GET', `/_matrix/key/v2/server/${encodeURIComponent(serverKeyPair.keyId)}`, env),
        req('GET', '/_matrix/key/v2/server', env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race leftover media thumbnail R2 barrier after #232', () => {
  it('pre-generated thumb key barrier: both 200 image/jpeg', async () => {
    const thumbKey = `thumb_${MEDIA_ID}_96x96_scale`;
    const media = mockR2(
      {
        [MEDIA_ID]: new Uint8Array([9, 9, 9]),
        [thumbKey]: new Uint8Array([1, 2, 3]),
      },
      { getBarrier: { count: 2, match: (key) => key === thumbKey } }
    );
    const db = createFedDb({
      media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'pic.png' }],
    });
    const env = makeEnv(db, { media });
    const path = `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=96&height=96&method=scale`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.headers.get('Content-Type') === 'image/jpeg')).toBe(true);
  });

  it('missing thumb falls back to original under race', async () => {
    const media = mockR2({ [MEDIA_ID]: new Uint8Array([4, 5, 6]) });
    const db = createFedDb({
      media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'pic.png' }],
    });
    const env = makeEnv(db, { media });
    const path = `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=32&height=32`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.headers.get('Content-Type') === 'image/png')).toBe(true);
    expect(results.every((r) => r.headers.get('X-Thumbnail-Generated') === 'false')).toBe(true);
  });

  it('thumbnail missing metadata 404∥download missing 404', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/media/thumbnail/nope', env),
      req('GET', '/_matrix/federation/v1/media/download/nope', env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  for (let i = 0; i < 8; i++) {
    it(`thumbnail leftover flood-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([i]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: `p${i}.png` }],
      });
      const env = makeEnv(db, { media });
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=${32 + i}&height=32`, env),
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race leftover event_auth∥backfill∥get_missing_events after #232', () => {
  it('event_auth dual walks create chain', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const path = `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent('$member:example.com')}`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(
      results.every((r) => (r.body as { auth_chain: unknown[] }).auth_chain.length >= 1)
    ).toBe(true);
  });

  it('event_auth missing room∥missing event isolation', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const [noRoom, noEvent] = await Promise.all([
      req(
        'GET',
        `/_matrix/federation/v1/event_auth/${encodeURIComponent('!x:example.com')}/${encodeURIComponent('$member:example.com')}`,
        env
      ),
      req(
        'GET',
        `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/%24missing`,
        env
      ),
    ]);
    expect(noRoom.status).toBe(404);
    expect(noEvent.status).toBe(404);
  });

  it('backfill dual recent pdus', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const path = `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=10`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(
      results.every((r) => Array.isArray((r.body as { pdus: unknown[] }).pdus) && (r.body as { pdus: unknown[] }).pdus.length > 0)
    ).toBe(true);
  });

  it('get_missing_events dual from member event', async () => {
    const db = seedBasicRoom();
    const env = makeEnv(db);
    const body = {
      earliest_events: [],
      latest_events: ['$member:example.com'],
      limit: 10,
      min_depth: 0,
    };
    const path = `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`;
    const results = await Promise.all([
      req('POST', path, env, body),
      req('POST', path, env, body),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => Array.isArray((r.body as { events: unknown[] }).events))).toBe(true);
  });

  it('backfill 403 when origin has no member∥ok isolation', async () => {
    const db = seedBasicRoom({
      memberships: [{ room_id: ROOM, user_id: LOCAL_USER, membership: 'join' }],
    });
    const env = makeEnv(db);
    const path = `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=2`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([403, 403]);
  });

  for (let i = 0; i < 8; i++) {
    it(`event_auth leftover flood-${i}`, async () => {
      const env = makeEnv(seedBasicRoom());
      const results = await Promise.all([
        req(
          'GET',
          `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent('$member:example.com')}`,
          env
        ),
        req('GET', `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=${(i % 3) + 1}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race leftover timestamp_to_event∥hierarchy after #232', () => {
  it('timestamp dir=f∥dir=b isolation at midpoint', async () => {
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
    const env = makeEnv(db);
    const base = `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}`;
    const [fwd, back] = await Promise.all([
      req('GET', `${base}?ts=1500&dir=f`, env),
      req('GET', `${base}?ts=1500&dir=b`, env),
    ]);
    expect(fwd.status).toBe(200);
    expect(back.status).toBe(200);
    expect((fwd.body as { event_id: string }).event_id).toBe('$t2');
    expect((back.body as { event_id: string }).event_id).toBe('$t1');
  });

  it('timestamp missing ts∥missing room isolation', async () => {
    const env = makeEnv(seedBasicRoom());
    const [noTs, noRoom] = await Promise.all([
      req('GET', `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}`, env),
      req('GET', '/_matrix/federation/v1/timestamp_to_event/%21no%3Ax?ts=1500', env),
    ]);
    expect(noTs.status).toBe(400);
    expect(noRoom.status).toBe(404);
  });

  it('hierarchy dual suggested_only', async () => {
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
    const env = makeEnv(db);
    const path = `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?suggested_only=true&limit=10`;
    const results = await Promise.all([req('GET', path, env), req('GET', path, env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(
      results.every((r) => (r.body as { room: { room_id: string } | null }).room?.room_id === ROOM)
    ).toBe(true);
  });

  it('hierarchy 404 missing room concurrent', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/hierarchy/%21no%3Ax', env),
      req('GET', '/_matrix/federation/v1/hierarchy/%21no%3Ax', env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  for (let i = 0; i < 8; i++) {
    it(`timestamp leftover flood-${i}`, async () => {
      const e = makeEvent({
        event_id: `$tf-${i}`,
        event_type: 'm.room.message',
        content: '{}',
        origin_server_ts: 1_700_000_000_000,
      });
      const env = makeEnv(createFedDb({ events: [e] }));
      const results = await Promise.all([
        req(
          'GET',
          `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=1700000000000&dir=f`,
          env
        ),
        req(
          'GET',
          `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=1700000000000&dir=b`,
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race leftover send cache∥openid expired after #232', () => {
  it('cached txn∥fresh txn isolation under Promise.all', async () => {
    const cached = JSON.stringify({ pdus: { cached: true } });
    const db = createFedDb({
      federationTxns: { [`${FED_ORIGIN}|cached`]: cached },
    });
    const env = makeEnv(db);
    const [hit, miss] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/cached', env, { pdus: [{ event_id: '$x' }] }),
      req('PUT', '/_matrix/federation/v1/send/fresh-leftover', env, { pdus: [] }),
    ]);
    expect(hit.status).toBe(200);
    expect(miss.status).toBe(200);
    expect((hit.body as { pdus: { cached: boolean } }).pdus.cached).toBe(true);
    expect(db.federationTxns[`${FED_ORIGIN}|fresh-leftover`]).toBeDefined();
  });

  it('already-expired openid both 401 and delete token', async () => {
    const sessions = mockKv(
      {
        'openid:exp': JSON.stringify({
          user_id: LOCAL_USER,
          expires_at: Date.now() - 5,
        }),
      },
      { getBarrier: { count: 2, match: (key) => key === 'openid:exp' } }
    );
    const env = makeEnv(createFedDb(), { sessions });
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=exp', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=exp', env),
    ]);
    expect(statusesOf(results)).toEqual([401, 401]);
    expect(sessions.data['openid:exp']).toBeUndefined();
  });

  it('publicRooms since=offset_0∥POST include_all_networks leftover', async () => {
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }],
    });
    const env = makeEnv(db);
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/publicRooms?limit=5&since=offset_0', env),
      req('POST', '/_matrix/federation/v1/publicRooms', env, {
        limit: 5,
        include_all_networks: true,
        third_party_instance_id: 'ignored',
      }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  for (let i = 0; i < 8; i++) {
    it(`send/openid leftover flood-${i}`, async () => {
      const db = createFedDb();
      const env = makeEnv(db, { sessions: mockKv() });
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/leftover-${i}`, env, { pdus: [], edus: [] }),
        req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=gone-${i}`, env),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 401]);
    });
  }
});

// residual concurrent races after #241 (route-leftover soft niches not raced post-#239)

describe('race residual hierarchy∥timestamp∥backfill triple after #241', () => {
  function seedSpace() {
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
    const t1 = makeEvent({
      event_id: '$t1',
      event_type: 'm.room.message',
      content: '{}',
      origin_server_ts: 1000,
    });
    const t2 = makeEvent({
      event_id: '$t2',
      event_type: 'm.room.message',
      content: '{}',
      origin_server_ts: 2000,
      depth: 2,
    });
    const depthEvents = [1, 2, 3, 4, 5].map((d) =>
      makeEvent({
        event_id: `$d${d}:example.com`,
        event_type: 'm.room.message',
        content: JSON.stringify({ body: String(d) }),
        depth: d,
      })
    );
    return createFedDb({
      rooms: [
        { room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 },
        { room_id: childRoom, room_version: '10', is_public: 1, created_at: 2 },
      ],
      events: [childEvt, name, childName, t1, t2, ...depthEvents],
      roomState: new Map([
        [stateKey(ROOM, 'm.space.child', childRoom), childEvt.event_id],
        [stateKey(ROOM, 'm.room.name', ''), name.event_id],
        [stateKey(childRoom, 'm.room.name', ''), childName.event_id],
      ]),
      memberships: [{ room_id: ROOM, user_id: `@m:${FED_ORIGIN}`, membership: 'join' }],
    });
  }

  it('hierarchy∥timestamp∥backfill triple 200', async () => {
    const env = makeEnv(seedSpace());
    const results = await Promise.all([
      req(
        'GET',
        `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?suggested_only=true&limit=10`,
        env
      ),
      req(
        'GET',
        `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=1500&dir=f`,
        env
      ),
      req('GET', `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=3`, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
  });

  for (let i = 0; i < 8; i++) {
    it(`hierarchy/timestamp/backfill residual flood-${i}`, async () => {
      const env = makeEnv(seedSpace());
      const dir = i % 2 === 0 ? 'f' : 'b';
      const results = await Promise.all([
        req(
          'GET',
          `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?from=offset_0`,
          env
        ),
        req(
          'GET',
          `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=1500&dir=${dir}`,
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual thumbnail∥download after #241', () => {
  it('thumbnail pre-gen∥download isolation', async () => {
    const thumbKey = `thumb_${MEDIA_ID}_96x96_scale`;
    const media = mockR2({
      [MEDIA_ID]: new Uint8Array([1, 2, 3]),
      [thumbKey]: new Uint8Array([9, 9, 9]),
    });
    const db = createFedDb({
      media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'pic.png' }],
    });
    const env = makeEnv(db, { media });
    const results = await Promise.all([
      req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=96&height=96&method=scale`,
        env
      ),
      req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('thumbnail missing∥download missing dual 404', async () => {
    const env = makeEnv(createFedDb());
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/media/thumbnail/nope', env),
      req('GET', '/_matrix/federation/v1/media/download/nope', env),
    ]);
    expect(statusesOf(results)).toEqual([404, 404]);
  });

  for (let i = 0; i < 8; i++) {
    it(`thumbnail/download residual flood-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([i, i + 1, i + 2]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: `p${i}.png` }],
      });
      const env = makeEnv(db, { media });
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=32&height=32`, env),
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual event_auth∥get_missing∥version after #241', () => {
  function seedAuthMissing() {
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
    return {
      child,
      db: createFedDb({
        events: [create, child, e1, e2],
        rooms: [{ room_id: ROOM, room_version: '10' }],
        memberships: [{ room_id: ROOM, user_id: `@m:${FED_ORIGIN}`, membership: 'join' }],
      }),
    };
  }

  it('event_auth∥get_missing isolation', async () => {
    const { child, db } = seedAuthMissing();
    const env = makeEnv(db);
    const results = await Promise.all([
      req(
        'GET',
        `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(child.event_id)}`,
        env
      ),
      req(
        'POST',
        `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
        env,
        { earliest_events: [], latest_events: ['$m2:example.com'], limit: 10 }
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((results[0].body as { auth_chain: unknown[] }).auth_chain.length).toBeGreaterThanOrEqual(1);
  });

  it('version∥publicRooms residual dual', async () => {
    const env = makeEnv(
      createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }],
      })
    );
    const results = await Promise.all([
      req('GET', '/_matrix/federation/v1/version', env),
      req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  for (let i = 0; i < 8; i++) {
    it(`event_auth/get_missing/version residual flood-${i}`, async () => {
      const { child, db } = seedAuthMissing();
      const env = makeEnv(db);
      const results = await Promise.all([
        req(
          'GET',
          `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(child.event_id)}`,
          env
        ),
        req('GET', '/_matrix/federation/v1/version', env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});
