/**
 * TOKENMAXX HEAVY leftovers after #214 / deepen after #232 / residual after #241
 * / residual after #252 / residual after #265 / second-wave residual after tip
 * #271 (post-#270) / tertiary residual after tip #275 (post-#275 second-wave)
 * — federation-api concurrent race / TOCTOU for leftover S2S routes
 * (non-catchup) that only had serial soft floods (#157 leftover). Distinct from
 * federation-keys-membership-account-data concurrent-race (OTK / make_join) and
 * federation-api-route-leftovers (serial floods). Distinct from tip
 * #241/#239/#265/#270/#275 prior deepens. Skip catchup residual covered by
 * #249/#250.
 *
 * Residual after #241: hierarchy∥timestamp∥backfill triple; thumbnail∥download;
 * event_auth∥get_missing isolation; version∥publicRooms — soft-flooded in
 * route leftovers deepen but not additional Promise.all races after #239.
 *
 * Residual after #252 (post-#248): send hash-mismatch∥prev-rejected;
 * download disposition∥octet-stream; thumbnail clamp∥non-image;
 * openid expired∥invalid; presence EDU∥noop EDU.
 *
 * Residual after #265 (post-#252, skip catchup): third-party∥origin sig;
 * missing-hash∥auth-denied; previously-accepted∥rejected; invalid PDU∥sender;
 * typing∥presence EDU; download 404∥thumb height-clamp.
 *
 * Second-wave residual after tip #271 (post-#270, skip catchup): legacy-v1∥
 * missing-hash-v10; Cache-Control-hit∥octet-stream; typing∥noop EDU;
 * custom-reject∥auth-fallback; openid success∥invalid; missing-origin∥empty-send.
 *
 * Tertiary residual after tip #275 (post-#275 second-wave, skip catchup):
 * invite not-invite∥signed-ok; not-local∥v2 bad-version; no-key∥ok serial dual;
 * v2 missing-param∥v1 mismatch — invite exact-string soft niches not dual-raced.
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

// residual concurrent races after #252 (non-catchup soft niches not raced post-#248)

const REMOTE_USER = `@remote:${FED_ORIGIN}`;
const MEDIA_DISP = 'fed_media_race';

describe('race residual send hash∥prev-rejected after #252', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockResolvedValue(false);
  });

  it('content-hash mismatch∥previously-rejected isolation', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    const eidMiss = '$racehash';
    const eidPrev = '$raceprev';
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      processedPdus: { [eidPrev]: { accepted: 0, rejection_reason: null } },
    });
    const env = makeEnv(db);
    const [miss, prev] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-race-hash', env, {
        pdus: [
          {
            event_id: eidMiss,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            hashes: { sha256: 'bad' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-race-prev', env, {
        pdus: [
          {
            event_id: eidPrev,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'y' },
          },
        ],
      }),
    ]);
    expect(miss.status).toBe(200);
    expect(prev.status).toBe(200);
    expect((miss.body as { pdus: Record<string, { error: string }> }).pdus[eidMiss].error).toBe(
      'Content hash mismatch'
    );
    expect((prev.body as { pdus: Record<string, { error: string }> }).pdus[eidPrev].error).toBe(
      'Previously rejected'
    );
  });

  it('origin-sig∥auth-throw accept isolation', async () => {
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
    });
    const env = makeEnv(db);
    verifyRemoteSignature.mockResolvedValueOnce(false).mockResolvedValue(true);
    verifyContentHash.mockResolvedValue(true);
    checkEventAuth.mockImplementation(() => {
      throw new Error('auth-race');
    });
    const [sig, accept] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-race-sig', env, {
        pdus: [
          {
            event_id: '$racesig',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'bad' } },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-race-accept', env, {
        pdus: [
          {
            event_id: '$raceaccept',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'y' },
            hashes: { sha256: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
    ]);
    expect(sig.status).toBe(200);
    expect(accept.status).toBe(200);
    expect((sig.body as { pdus: Record<string, { error: string }> }).pdus['$racesig'].error).toBe(
      'PDU from origin server without valid signature'
    );
    expect((accept.body as { pdus: Record<string, unknown> }).pdus['$raceaccept']).toEqual({});
  });

  for (let i = 0; i < 8; i++) {
    it(`send residual flood-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      verifyContentHash.mockResolvedValue(false);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
        processedPdus: { [`$prev${i}`]: { accepted: 0, rejection_reason: null } },
      });
      const env = makeEnv(db);
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/txn-rf-h-${i}`, env, {
          pdus: [
            {
              event_id: `$hm${i}`,
              room_id: ROOM,
              sender: REMOTE_USER,
              type: 'm.room.message',
              content: { body: 'x' },
              hashes: { sha256: 'bad' },
              signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
            },
          ],
        }),
        req('PUT', `/_matrix/federation/v1/send/txn-rf-p-${i}`, env, {
          pdus: [
            {
              event_id: `$prev${i}`,
              room_id: ROOM,
              sender: REMOTE_USER,
              type: 'm.room.message',
              content: { body: 'y' },
            },
          ],
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual media disposition∥openid∥edu after #252', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('download disposition∥octet-stream dual', async () => {
    const media = mockR2({
      [MEDIA_DISP]: new Uint8Array([1, 2, 3]),
      orphan_race: new Uint8Array([9, 9, 9]),
    });
    const db = createFedDb({
      media: [{ media_id: MEDIA_DISP, content_type: 'image/png', filename: 'race.png' }],
    });
    const env = makeEnv(db, { media });
    const [withName, orphan] = await Promise.all([
      req('GET', `/_matrix/federation/v1/media/download/${MEDIA_DISP}`, env),
      req('GET', '/_matrix/federation/v1/media/download/orphan_race', env),
    ]);
    expect(statusesOf([withName, orphan])).toEqual([200, 200]);
    expect(withName.headers.get('Content-Disposition')).toBe('inline; filename="race.png"');
    expect(orphan.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('thumbnail clamp∥non-image isolation', async () => {
    const thumbKey = `thumb_${MEDIA_DISP}_1920x64_scale`;
    const media = mockR2({
      [MEDIA_DISP]: new Uint8Array([1, 2, 3]),
      [thumbKey]: new Uint8Array([8, 8, 8]),
      pdf_race: new Uint8Array([4, 5, 6]),
    });
    const db = createFedDb({
      media: [
        { media_id: MEDIA_DISP, content_type: 'image/png', filename: 'a.png' },
        { media_id: 'pdf_race', content_type: 'application/pdf', filename: 'a.pdf' },
      ],
    });
    const env = makeEnv(db, { media });
    const [clamp, pdf] = await Promise.all([
      req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_DISP}?width=99999&height=64&method=scale`,
        env
      ),
      req('GET', '/_matrix/federation/v1/media/thumbnail/pdf_race?width=64&height=64', env),
    ]);
    expect(statusesOf([clamp, pdf])).toEqual([200, 200]);
    expect(clamp.headers.get('Content-Type')).toBe('image/jpeg');
    expect(pdf.headers.get('X-Thumbnail-Generated')).toBeNull();
  });

  it('openid expired∥invalid text dual', async () => {
    const sessions = mockKv({
      'openid:exp_race': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() - 5000 }),
    });
    const env = makeEnv(createFedDb(), { sessions });
    const [expired, invalid] = await Promise.all([
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=exp_race', env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=nope_race', env),
    ]);
    expect(statusesOf([expired, invalid])).toEqual([401, 401]);
    expect((expired.body as { error: string }).error).toBe('OpenID token has expired');
    expect((invalid.body as { error: string }).error).toBe('Invalid or expired OpenID token');
  });

  it('presence EDU∥noop EDU dual record', async () => {
    const db = createFedDb();
    const env = makeEnv(db);
    const [pres, noop] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-race-pres', env, {
        pdus: [],
        edus: [
          {
            edu_type: 'm.presence',
            content: {
              push: [{ user_id: `@p:${FED_ORIGIN}`, presence: 'online', currently_active: true }],
            },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-race-noop', env, {
        pdus: [],
        edus: [{ edu_type: 'm.receipt', content: { n: 1 } }],
      }),
    ]);
    expect(statusesOf([pres, noop])).toEqual([200, 200]);
    expect(db.inserts.some((ins) => String(ins.sql).includes('INSERT INTO presence'))).toBe(true);
    expect(
      db.inserts.filter((ins) => String(ins.sql).includes('INSERT OR REPLACE INTO processed_edus')).length
    ).toBeGreaterThanOrEqual(2);
  });

  for (let i = 0; i < 8; i++) {
    it(`media/openid residual flood-${i}`, async () => {
      const media = mockR2({
        [MEDIA_DISP]: new Uint8Array([i, i + 1, i + 2]),
      });
      const db = createFedDb({
        media: [{ media_id: MEDIA_DISP, content_type: 'image/png', filename: `f${i}.png` }],
      });
      const sessions = mockKv({
        [`openid:ok${i}`]: JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60_000 }),
      });
      const env = makeEnv(db, { media, sessions });
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA_DISP}`, env),
        req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=ok${i}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

// residual concurrent races after #265 (non-catchup soft niches not raced post-#252)

describe('race residual third-party∥origin / missing-hash∥auth-denied after #265', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockResolvedValue(true);
  });

  it('third-party sig∥origin-server sig isolation', async () => {
    verifyRemoteSignature.mockResolvedValue(false);
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
    });
    const env = makeEnv(db);
    const [third, origin] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-r265-third', env, {
        pdus: [
          {
            event_id: '$r265third',
            room_id: ROOM,
            sender: '@carol:other.example.com',
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { 'other.example.com': { 'ed25519:1': 'sig' } },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-r265-origin', env, {
        pdus: [
          {
            event_id: '$r265origin',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'y' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'bad' } },
          },
        ],
      }),
    ]);
    expect(statusesOf([third, origin])).toEqual([200, 200]);
    expect((third.body as { pdus: Record<string, { error: string }> }).pdus['$r265third'].error).toBe(
      'Third-party PDU without valid signature'
    );
    expect((origin.body as { pdus: Record<string, { error: string }> }).pdus['$r265origin'].error).toBe(
      'PDU from origin server without valid signature'
    );
  });

  it('missing-hash v10∥auth-denied isolation', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    verifyContentHash.mockResolvedValue(true);
    checkEventAuth.mockReturnValue({ allowed: false, error: 'power levels' });
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
    });
    const env = makeEnv(db);
    const [nohash, deny] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-r265-nohash', env, {
        pdus: [
          {
            event_id: '$r265nohash',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-r265-deny', env, {
        pdus: [
          {
            event_id: '$r265deny',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'y' },
            hashes: { sha256: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
    ]);
    expect(statusesOf([nohash, deny])).toEqual([200, 200]);
    expect((nohash.body as { pdus: Record<string, { error: string }> }).pdus['$r265nohash'].error).toBe(
      'Missing required hashes.sha256 (room_version=10)'
    );
    expect((deny.body as { pdus: Record<string, { error: string }> }).pdus['$r265deny'].error).toBe(
      'power levels'
    );
  });

  for (let i = 0; i < 8; i++) {
    it(`third/hash residual flood-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(false);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const env = makeEnv(db);
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/txn-r265-t-${i}`, env, {
          pdus: [
            {
              event_id: `$t265_${i}`,
              room_id: ROOM,
              sender: '@carol:other.example.com',
              type: 'm.room.message',
              content: { body: 'x' },
              signatures: { 'other.example.com': { 'ed25519:1': 'sig' } },
            },
          ],
        }),
        req('PUT', `/_matrix/federation/v1/send/txn-r265-o-${i}`, env, {
          pdus: [
            {
              event_id: `$o265_${i}`,
              room_id: ROOM,
              sender: REMOTE_USER,
              type: 'm.room.message',
              content: { body: 'y' },
              signatures: { [FED_ORIGIN]: { 'ed25519:1': 'bad' } },
            },
          ],
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual previously-accepted∥rejected / invalid PDU∥sender after #265', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
  });

  it('previously-accepted∥previously-rejected isolation', async () => {
    const db = createFedDb({
      processedPdus: {
        '$r265ok': { accepted: 1, rejection_reason: null },
        '$r265no': { accepted: 0, rejection_reason: null },
      },
    });
    const env = makeEnv(db);
    const [ok, no] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-r265-ok', env, {
        pdus: [
          {
            event_id: '$r265ok',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-r265-no', env, {
        pdus: [
          {
            event_id: '$r265no',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'y' },
          },
        ],
      }),
    ]);
    expect(statusesOf([ok, no])).toEqual([200, 200]);
    expect((ok.body as { pdus: Record<string, unknown> }).pdus['$r265ok']).toEqual({});
    expect((no.body as { pdus: Record<string, { error: string }> }).pdus['$r265no'].error).toBe(
      'Previously rejected'
    );
  });

  it('invalid PDU structure∥invalid sender dual', async () => {
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
    });
    const env = makeEnv(db);
    const [struct, sender] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-r265-struct', env, {
        pdus: [{ event_id: '$r265struct', room_id: ROOM }],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-r265-sender', env, {
        pdus: [
          {
            event_id: '$r265sender',
            room_id: ROOM,
            sender: 'noserver',
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      }),
    ]);
    expect(statusesOf([struct, sender])).toEqual([200, 200]);
    expect((struct.body as { pdus: Record<string, { error: string }> }).pdus['$r265struct'].error).toBe(
      'Invalid PDU structure'
    );
    expect((sender.body as { pdus: Record<string, { error: string }> }).pdus['$r265sender'].error).toBe(
      'Invalid sender format'
    );
  });

  for (let i = 0; i < 8; i++) {
    it(`prev/invalid residual flood-${i}`, async () => {
      const db = createFedDb({
        processedPdus: {
          [`$ok265_${i}`]: { accepted: 1, rejection_reason: null },
          [`$no265_${i}`]: { accepted: 0, rejection_reason: null },
        },
      });
      const env = makeEnv(db);
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/txn-r265-ok-${i}`, env, {
          pdus: [
            {
              event_id: `$ok265_${i}`,
              room_id: ROOM,
              sender: REMOTE_USER,
              type: 'm.room.message',
              content: { body: 'x' },
            },
          ],
        }),
        req('PUT', `/_matrix/federation/v1/send/txn-r265-no-${i}`, env, {
          pdus: [
            {
              event_id: `$no265_${i}`,
              room_id: ROOM,
              sender: REMOTE_USER,
              type: 'm.room.message',
              content: { body: 'y' },
            },
          ],
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

describe('race residual typing∥presence EDU / media 404∥thumb height after #265', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('typing EDU∥presence EDU dual record', async () => {
    const db = createFedDb();
    const env = makeEnv(db);
    const [typing, presence] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-r265-typing', env, {
        pdus: [],
        edus: [{ edu_type: 'm.typing', content: { room_id: ROOM } }],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-r265-pres', env, {
        pdus: [],
        edus: [
          {
            edu_type: 'm.presence',
            content: {
              push: [{ user_id: `@p265:${FED_ORIGIN}`, presence: 'online', currently_active: true }],
            },
          },
        ],
      }),
    ]);
    expect(statusesOf([typing, presence])).toEqual([200, 200]);
    expect(db.inserts.some((ins) => String(ins.sql).includes('INSERT INTO presence'))).toBe(true);
    const eduRows = db.inserts.filter((ins) => String(ins.sql).includes('INSERT OR REPLACE INTO processed_edus'));
    expect(eduRows.length).toBeGreaterThanOrEqual(2);
    expect(eduRows.some((ins) => ins.args[1] === 'm.typing')).toBe(true);
  });

  it('download 404∥thumbnail height-clamp isolation', async () => {
    const MEDIA = 'fed_media_r265';
    const thumbKey = `thumb_${MEDIA}_64x1920_scale`;
    const media = mockR2({
      [MEDIA]: new Uint8Array([1, 2, 3]),
      [thumbKey]: new Uint8Array([8, 8, 8]),
    });
    const db = createFedDb({
      media: [{ media_id: MEDIA, content_type: 'image/png', filename: 'a.png' }],
    });
    const env = makeEnv(db, { media });
    const [miss, clamp] = await Promise.all([
      req('GET', '/_matrix/federation/v1/media/download/missing_r265', env),
      req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA}?width=64&height=99999&method=scale`,
        env
      ),
    ]);
    expect(miss.status).toBe(404);
    expect((miss.body as { error: string }).error).toBe('Media not found');
    expect(clamp.status).toBe(200);
    expect(clamp.headers.get('Content-Type')).toBe('image/jpeg');
  });

  for (let i = 0; i < 8; i++) {
    it(`edu/media residual flood-${i}`, async () => {
      const MEDIA = 'fed_media_r265';
      const media = mockR2({ [MEDIA]: new Uint8Array([i, i + 1, i + 2]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA, content_type: 'image/png', filename: `f${i}.png` }],
      });
      const env = makeEnv(db, { media });
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/txn-r265-ty-${i}`, env, {
          pdus: [],
          edus: [{ edu_type: 'm.typing', content: { room_id: ROOM } }],
        }),
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

// second-wave residual concurrent races after tip #271 (post-#270, skip catchup)

describe('race second-wave legacy∥hash-v10 / custom-reject∥auth-fallback after #271', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockResolvedValue(true);
  });

  it('legacy v1 accept∥missing-hash v10 isolation', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    const roomV1 = '!v1:example.com';
    const roomV10 = '!v10:example.com';
    const db = createFedDb({
      rooms: [
        { room_id: roomV1, room_version: '1', is_public: 1, created_at: 1 },
        { room_id: roomV10, room_version: '10', is_public: 1, created_at: 2 },
      ],
    });
    const env = makeEnv(db);
    const [legacy, nohash] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-sw-legacy', env, {
        pdus: [
          {
            event_id: '$swlegacy',
            room_id: roomV1,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-sw-nohash', env, {
        pdus: [
          {
            event_id: '$swnohash',
            room_id: roomV10,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
    ]);
    expect(statusesOf([legacy, nohash])).toEqual([200, 200]);
    expect((legacy.body as { pdus: Record<string, unknown> }).pdus['$swlegacy']).toEqual({});
    expect((nohash.body as { pdus: Record<string, { error: string }> }).pdus['$swnohash'].error).toBe(
      'Missing required hashes.sha256 (room_version=10)'
    );
  });

  it('custom rejection_reason∥auth-fallback isolation', async () => {
    verifyRemoteSignature.mockResolvedValue(true);
    verifyContentHash.mockResolvedValue(true);
    checkEventAuth.mockReturnValue({ allowed: false });
    const db = createFedDb({
      rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      processedPdus: { '$swcustom': { accepted: 0, rejection_reason: 'custom-reason-race' } },
    });
    const env = makeEnv(db);
    const [prev, deny] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-sw-custom', env, {
        pdus: [
          {
            event_id: '$swcustom',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-sw-authfb', env, {
        pdus: [
          {
            event_id: '$swauthfb',
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'y' },
            hashes: { sha256: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      }),
    ]);
    expect(statusesOf([prev, deny])).toEqual([200, 200]);
    expect((prev.body as { pdus: Record<string, { error: string }> }).pdus['$swcustom'].error).toBe(
      'custom-reason-race'
    );
    expect((deny.body as { pdus: Record<string, { error: string }> }).pdus['$swauthfb'].error).toBe(
      'Event authorization failed'
    );
  });

  for (let i = 0; i < 8; i++) {
    it(`legacy/hash second-wave flood-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      const db = createFedDb({
        rooms: [
          { room_id: ROOM, room_version: '1', is_public: 1, created_at: 1 },
        ],
      });
      const env = makeEnv(db);
      const results = await Promise.all([
        req('PUT', `/_matrix/federation/v1/send/txn-sw-l-${i}`, env, {
          pdus: [
            {
              event_id: `$swl_${i}`,
              room_id: ROOM,
              sender: REMOTE_USER,
              type: 'm.room.message',
              content: { body: 'ok' },
              signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
            },
          ],
        }),
        req('PUT', `/_matrix/federation/v1/send/txn-sw-u-${i}`, env, {
          pdus: [{ room_id: ROOM, type: 'm.room.message', content: { body: 'x' } }],
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect((results[1].body as { pdus: Record<string, { error: string }> }).pdus.unknown.error).toBe(
        'Invalid PDU structure'
      );
    });
  }
});

describe('race second-wave Cache-Control∥octet / typing∥noop / openid / origin after #271', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('download Cache-Control hit∥octet-stream orphan isolation', async () => {
    const MEDIA = 'fed_media_sw_hit';
    const orphan = 'fed_media_sw_orphan';
    const media = mockR2({
      [MEDIA]: new Uint8Array([1, 2, 3]),
      [orphan]: new Uint8Array([9, 9, 9]),
    });
    const db = createFedDb({
      media: [{ media_id: MEDIA, content_type: 'image/png', filename: 'hit.png' }],
    });
    const env = makeEnv(db, { media });
    const [hit, octet] = await Promise.all([
      req('GET', `/_matrix/federation/v1/media/download/${MEDIA}`, env),
      req('GET', `/_matrix/federation/v1/media/download/${orphan}`, env),
    ]);
    expect(statusesOf([hit, octet])).toEqual([200, 200]);
    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(hit.headers.get('Content-Type')).toBe('image/png');
    expect(octet.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(octet.headers.get('Content-Disposition')).toBeNull();
  });

  it('typing∥noop EDU edu_type bind isolation', async () => {
    const db = createFedDb();
    const env = makeEnv(db);
    const [typing, noop] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-sw-typing', env, {
        pdus: [],
        edus: [{ edu_type: 'm.typing', content: { room_id: ROOM, user_ids: [`@t:${FED_ORIGIN}`] } }],
      }),
      req('PUT', '/_matrix/federation/v1/send/txn-sw-noop', env, {
        pdus: [],
        edus: [{ edu_type: 'm.receipt', content: { n: 1 } }],
      }),
    ]);
    expect(statusesOf([typing, noop])).toEqual([200, 200]);
    const eduInserts = db.inserts.filter((ins) =>
      String(ins.sql).includes('INSERT OR REPLACE INTO processed_edus')
    );
    expect(eduInserts.some((ins) => ins.args[1] === 'm.typing')).toBe(true);
    expect(eduInserts.some((ins) => ins.args[1] === 'm.receipt')).toBe(true);
  });

  it('openid success∥invalid isolation + token retained', async () => {
    const tok = 'sw_openid_ok';
    const sessions = mockKv({
      [`openid:${tok}`]: JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 120_000 }),
    });
    const env = makeEnv(createFedDb(), { sessions });
    const [ok, bad] = await Promise.all([
      req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=${tok}`, env),
      req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=missing_sw', env),
    ]);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ sub: LOCAL_USER });
    expect(sessions.data[`openid:${tok}`]).toBeTruthy();
    expect(bad.status).toBe(401);
    expect((bad.body as { errcode: string }).errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('missing-origin then empty-send serial dual bind', async () => {
    const db = createFedDb();
    const env = makeEnv(db);
    federationOrigin = undefined;
    const a = await req('PUT', '/_matrix/federation/v1/send/txn-sw-noorig2', env, { pdus: [] });
    expect(a.status).toBe(401);
    expect((a.body as { error: string }).error).toBe('Federation authentication required');
    federationOrigin = FED_ORIGIN;
    const b = await req('PUT', '/_matrix/federation/v1/send/txn-sw-empty2', env, { pdus: [], edus: [] });
    expect(b.status).toBe(200);
    expect(db.federationTxns[`${FED_ORIGIN}|txn-sw-empty2`]).toBeDefined();
  });

  for (let i = 0; i < 8; i++) {
    it(`media/edu/openid second-wave flood-${i}`, async () => {
      const MEDIA = 'fed_media_sw_f';
      const media = mockR2({ [MEDIA]: new Uint8Array([i, i + 1]) });
      const sessions = mockKv({
        [`openid:swf_${i}`]: JSON.stringify({
          user_id: LOCAL_USER,
          expires_at: Date.now() + 60_000,
        }),
      });
      const db = createFedDb({
        media: [{ media_id: MEDIA, content_type: 'image/png', filename: `f${i}.png` }],
      });
      const env = makeEnv(db, { media, sessions });
      const results = await Promise.all([
        req('GET', `/_matrix/federation/v1/media/download/${MEDIA}`, env),
        req('GET', `/_matrix/federation/v1/openid/userinfo?access_token=swf_${i}`, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(results[1].body).toEqual({ sub: LOCAL_USER });
    });
  }
});

// tertiary residual concurrent races after tip #275 (invite soft niches not dual-raced)

describe('race tertiary invite not-invite∥ok / not-local∥bad-version / no-key after #275', () => {
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

  function inviteEnv(extra: Parameters<typeof createFedDb>[0] = {}) {
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
            valid_until: Date.now() + 100_000,
            is_current: 1,
          },
        ],
        ...extra,
      })
    );
  }

  it('v1 not-invite∥signed-ok isolation', async () => {
    const env = inviteEnv();
    const eid = '$race_ok';
    const [bad, ok] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_ni')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'join' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(eid)}`,
        env,
        {
          event: {
            event_id: eid,
            type: 'm.room.member',
            content: { membership: 'invite' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          },
        }
      ),
    ]);
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toBe('Event is not an invite event');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect((ok.body as [number, { signatures: unknown }])[0]).toBe(200);
    expect((ok.body as [number, { signatures: unknown }])[1].signatures).toBeDefined();
  });

  it('v1 not-local∥v2 Unsupported room version isolation', async () => {
    const env = inviteEnv();
    const [notLocal, badVer] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_nl')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: '@x:other.com',
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_uv')}`,
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
      ),
    ]);
    expect(notLocal.status).toBe(403);
    expect((notLocal.body as { error: string }).error).toBe('User is not local to this server');
    expect(badVer.status).toBe(400);
    expect((badVer.body as { error: string }).error).toBe('Unsupported room version: 99');
  });

  it('v1 no-key then signed-ok serial dual', async () => {
    const a = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_nk')}`,
      inviteEnv({ serverKeys: [] }),
      {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      }
    );
    expect(a.status).toBe(500);
    expect((a.body as { error: string }).error).toBe('Server signing key not configured');

    const eid = '$race_serial_ok';
    const b = await req(
      'PUT',
      `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(eid)}`,
      inviteEnv(),
      {
        event: {
          event_id: eid,
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      }
    );
    expect(b.status).toBe(200);
    expect((b.body as [number, unknown])[0]).toBe(200);
  });

  it('v2 missing room_version∥v1 event_id mismatch isolation', async () => {
    const env = inviteEnv();
    const [missingRv, mismatch] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_nrv')}`,
        env,
        {
          event: {
            type: 'm.room.member',
            content: { membership: 'invite' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          },
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$want')}`,
        env,
        {
          event_id: '$other',
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        }
      ),
    ]);
    expect(missingRv.status).toBe(400);
    expect((missingRv.body as { error: string }).error).toBe(
      'Missing required parameter: room_version'
    );
    expect(mismatch.status).toBe(400);
    expect((mismatch.body as { error: string }).error).toBe('Event ID mismatch');
  });

  it('v2 success∥v1 wrong-origin isolation', async () => {
    const env = inviteEnv();
    const eid = '$race_v2ok';
    const [ok, wrong] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(eid)}`,
        env,
        {
          room_version: '10',
          event: {
            event_id: eid,
            type: 'm.room.member',
            content: { membership: 'invite' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          },
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_wo')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: '@eve:evil.example.com',
          state_key: LOCAL_USER,
        }
      ),
    ]);
    expect(ok.status).toBe(200);
    expect((ok.body as { event: { signatures: unknown } }).event.signatures).toBeDefined();
    expect(wrong.status).toBe(403);
    expect((wrong.body as { error: string }).error).toBe(
      'Sender does not belong to the authenticated origin server'
    );
  });

  for (let i = 0; i < 8; i++) {
    it(`invite tertiary residual flood-${i}`, async () => {
      const env = inviteEnv();
      const results = await Promise.all([
        req(
          'PUT',
          `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$fni${i}`)}`,
          env,
          {
            type: 'm.room.member',
            content: { membership: 'join' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          }
        ),
        req(
          'PUT',
          `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$fuv${i}`)}`,
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
        ),
      ]);
      expect(statusesOf(results)).toEqual([400, 400]);
      expect((results[0].body as { error: string }).error).toBe('Event is not an invite event');
      expect((results[1].body as { error: string }).error).toBe('Unsupported room version: 99');
    });
  }
});
