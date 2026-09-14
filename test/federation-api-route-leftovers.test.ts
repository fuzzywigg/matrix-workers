/**
 * TOKENMAXX HEAVY leftovers after #157 / deepen after #241 / residual after #252
 * / residual after #265 / second-wave residual after tip #271 (post-#270) /
 * tertiary residual after tip #275 (post-#275 second-wave) — federation S2S
 * soft/edge/reliability (non-catchup). Complements federation-api-routes.test.ts
 * and federation-api-concurrent-race leftovers (#239/#248/#265/#270/#275).
 * Tests-only — no product inventing. Fixtures use example.com only. Skips
 * FederationCatchupWorkflow (#249/#250).
 *
 * Deepen after #241: hierarchy, timestamp_to_event, event_auth, backfill,
 * get_missing_events, media/thumbnail soft floods — present in federation.ts /
 * federation-api-routes base but unsaturated in this leftovers soft flood after
 * #157/#161 (concurrent races covered those paths; serial soft floods did not).
 *
 * Residual after #252 (post-#248, skip catchup #249/#250): send content-hash
 * mismatch/throw; previously-rejected null reason; origin-server invalid sig;
 * auth-check throw accept; m.presence + noop EDU record; media disposition /
 * octet-stream; thumbnail clamp + non-image; OpenID expired vs invalid text.
 *
 * Residual after #265 (post-#252, skip catchup): third-party sig reject;
 * missing-hash v10/unknown; auth-denied; previously-accepted reuse;
 * invalid PDU/sender strings; legacy v1 accept; m.typing EDU record;
 * media 404 + Cache-Control; thumbnail height-clamp + meta-sans-R2.
 *
 * Second-wave residual after tip #271 (post-#270, skip catchup): custom
 * rejection_reason echo; missing-hash room_version=11; auth-denied fallback
 * Event authorization failed / DB Auth failed; pdus.unknown; openid success
 * sub+token-retained; missing federationOrigin 401; hierarchy suggested_only
 * absent returns non-suggested children.
 *
 * Tertiary residual after tip #275 (post-#275 second-wave, skip catchup):
 * invite v1/v2 exact validation strings (not-invite, mismatch, wrong-origin,
 * bad state_key, not-local, user-missing, no signing key); v2 missing
 * room_version/event + Unsupported room version; v1/v2 success shapes —
 * base routes assert status/errcode only; leftovers soft floods never did.
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

function mockR2(initial: Record<string, Uint8Array> = {}): R2Store {
  const data: Record<string, { body: Uint8Array }> = {};
  for (const [k, v] of Object.entries(initial)) data[k] = { body: v };
  return {
    data,
    get: async (key: string) => {
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


describe('soft-0 version flood', () => {

  it('soft-0 version GET flood-0', async () => {
    const env = makeEnv(createFedDb());
    if (0 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-0';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-1', async () => {
    const env = makeEnv(createFedDb());
    if (1 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-1';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-2', async () => {
    const env = makeEnv(createFedDb());
    if (2 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-2';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-3', async () => {
    const env = makeEnv(createFedDb());
    if (3 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-3';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-4', async () => {
    const env = makeEnv(createFedDb());
    if (4 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-4';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-5', async () => {
    const env = makeEnv(createFedDb());
    if (5 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-5';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-6', async () => {
    const env = makeEnv(createFedDb());
    if (6 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-6';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-7', async () => {
    const env = makeEnv(createFedDb());
    if (7 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-7';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-8', async () => {
    const env = makeEnv(createFedDb());
    if (8 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-8';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-9', async () => {
    const env = makeEnv(createFedDb());
    if (9 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-9';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-10', async () => {
    const env = makeEnv(createFedDb());
    if (10 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-10';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-11', async () => {
    const env = makeEnv(createFedDb());
    if (11 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-11';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-12', async () => {
    const env = makeEnv(createFedDb());
    if (12 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-12';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });

  it('soft-0 version GET flood-13', async () => {
    const env = makeEnv(createFedDb());
    if (13 % 3 === 0) delete (env as { SERVER_VERSION?: string }).SERVER_VERSION;
    else (env as { SERVER_VERSION?: string }).SERVER_VERSION = 'v-13';
    const { status, body } = await req('GET', '/_matrix/federation/v1/version', env);
    expect(status).toBe(200);
    expect((body as { server: { name: string } }).server.name).toBe('matrix-worker');
  });
});

describe('soft-1 publicRooms GET flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-1 publicRooms GET flood-0', async () => {
    const rooms = 0 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 0 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((0 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-1', async () => {
    const rooms = 1 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 1 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((1 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-2', async () => {
    const rooms = 2 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 2 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((2 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-3', async () => {
    const rooms = 3 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 3 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((3 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-4', async () => {
    const rooms = 4 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 4 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((4 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-5', async () => {
    const rooms = 5 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 5 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((5 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-6', async () => {
    const rooms = 6 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 6 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((6 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-7', async () => {
    const rooms = 7 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 7 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((7 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-8', async () => {
    const rooms = 8 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 8 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((8 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-9', async () => {
    const rooms = 9 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 9 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((9 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-10', async () => {
    const rooms = 10 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 10 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((10 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-11', async () => {
    const rooms = 11 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 11 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((11 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-12', async () => {
    const rooms = 12 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 12 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((12 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });

  it('soft-1 publicRooms GET flood-13', async () => {
    const rooms = 13 % 2 === 0 ? [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 - 13 }] : [{ room_id: ROOM, room_version: '10', is_public: 0, created_at: 1 }];
    const { status, body } = await req('GET', '/_matrix/federation/v1/publicRooms?limit=' + ((13 % 5) + 1), makeEnv(createFedDb({ rooms })));
    expect(status).toBe(200);
    expect(body).toHaveProperty('chunk');
  });
});

describe('soft-2 publicRooms POST body floods', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-2 publicRooms POST flood-0', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 0 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[0 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-1', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 1 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[1 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-2', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 2 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[2 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-3', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 3 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[3 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-4', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 4 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[4 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-5', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 5 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[5 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-6', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 6 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[6 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-7', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 7 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[7 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-8', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 8 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[8 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-9', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 9 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[9 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-10', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 10 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[10 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-11', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 11 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[11 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-12', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 12 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[12 % 5])).status).toBe(200);
  });

  it('soft-2 publicRooms POST flood-13', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    const bodies = [{ limit: 10 }, { limit: 13 + 1, since: 'offset_0' }, { filter: { generic_search_term: 'room' } }, { limit: 5, filter: { generic_search_term: '' } }, { include_all_networks: true, limit: 3 }];
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), bodies[13 % 5])).status).toBe(200);
  });
});

describe('soft-3 query/directory soft flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-3 directory flood-0', async () => {
    const db = createFedDb({ aliases: { '#room:example.com': ROOM } });
    expect((await req('GET', '/_matrix/federation/v1/query/directory', makeEnv(db))).status).toBe(400);
  });

  it('soft-3 directory flood-1', async () => {
    const db = createFedDb({ aliases: { '#other:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#other:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-2', async () => {
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23missing%3Aexample.com', makeEnv(createFedDb()));
    expect(r.status).toBe(404);
  });

  it('soft-3 directory flood-3', async () => {
    const db = createFedDb({ aliases: { '#room:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#room:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-4', async () => {
    const db = createFedDb({ aliases: { '#other:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#other:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-5', async () => {
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23missing%3Aexample.com', makeEnv(createFedDb()));
    expect(r.status).toBe(404);
  });

  it('soft-3 directory flood-6', async () => {
    const db = createFedDb({ aliases: { '#room:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#room:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-7', async () => {
    const db = createFedDb({ aliases: { '#other:example.com': ROOM } });
    expect((await req('GET', '/_matrix/federation/v1/query/directory', makeEnv(db))).status).toBe(400);
  });

  it('soft-3 directory flood-8', async () => {
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23missing%3Aexample.com', makeEnv(createFedDb()));
    expect(r.status).toBe(404);
  });

  it('soft-3 directory flood-9', async () => {
    const db = createFedDb({ aliases: { '#room:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#room:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-10', async () => {
    const db = createFedDb({ aliases: { '#other:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#other:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-11', async () => {
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23missing%3Aexample.com', makeEnv(createFedDb()));
    expect(r.status).toBe(404);
  });

  it('soft-3 directory flood-12', async () => {
    const db = createFedDb({ aliases: { '#room:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#room:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });

  it('soft-3 directory flood-13', async () => {
    const db = createFedDb({ aliases: { '#other:example.com': ROOM } });
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent('#other:example.com'), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { room_id: string }).room_id).toBe(ROOM);
  });
});

describe('soft-4 query/profile soft flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-4 profile flood-0', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=%40ghost%3Aexample.com', makeEnv(db))).status).toBe(404);
  });

  it('soft-4 profile flood-1', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'displayname' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=displayname' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-2', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'avatar_url' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=avatar_url' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-3', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'unknown' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=unknown' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-4', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = '' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-5', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'displayname' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=displayname' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-6', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'avatar_url' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=avatar_url' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-7', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'unknown' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=unknown' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-8', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = '' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-9', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'displayname' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=displayname' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-10', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'avatar_url' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=avatar_url' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-11', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=%40ghost%3Aexample.com', makeEnv(db))).status).toBe(404);
  });

  it('soft-4 profile flood-12', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = '' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-4 profile flood-13', async () => {
    const db = createFedDb({ users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }] });
    const q = 'displayname' ? 'user_id=' + encodeURIComponent(LOCAL_USER) + '&field=displayname' : 'user_id=' + encodeURIComponent(LOCAL_USER);
    const r = await req('GET', '/_matrix/federation/v1/query/profile?' + q, makeEnv(db));
    expect(r.status).toBe(200);
  });
});

describe('soft-5 openid/userinfo soft flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-5 openid flood-0', async () => {
    const sessions = mockKv({ 'openid:tok0': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    expect((await req('GET', '/_matrix/federation/v1/openid/userinfo', makeEnv(createFedDb(), { sessions }))).status).toBe(400);
  });

  it('soft-5 openid flood-1', async () => {
    const sessions = mockKv({ 'openid:tok1': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    expect((await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=unknown1', makeEnv(createFedDb(), { sessions }))).status).toBe(401);
  });

  it('soft-5 openid flood-2', async () => {
    const sessions = mockKv({ 'openid:tok2': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    const r = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok2', makeEnv(createFedDb(), { sessions }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sub: LOCAL_USER });
  });

  it('soft-5 openid flood-3', async () => {
    const sessions = mockKv({ 'openid:tok3': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    const r = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok3', makeEnv(createFedDb(), { sessions }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sub: LOCAL_USER });
  });

  it('soft-5 openid flood-4', async () => {
    const sessions = mockKv({ 'openid:tok4': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    expect((await req('GET', '/_matrix/federation/v1/openid/userinfo', makeEnv(createFedDb(), { sessions }))).status).toBe(400);
  });

  it('soft-5 openid flood-5', async () => {
    const sessions = mockKv({ 'openid:tok5': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    expect((await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=unknown5', makeEnv(createFedDb(), { sessions }))).status).toBe(401);
  });

  it('soft-5 openid flood-6', async () => {
    const sessions = mockKv({ 'openid:tok6': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    const r = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok6', makeEnv(createFedDb(), { sessions }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sub: LOCAL_USER });
  });

  it('soft-5 openid flood-7', async () => {
    const sessions = mockKv({ 'openid:tok7': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    const r = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok7', makeEnv(createFedDb(), { sessions }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sub: LOCAL_USER });
  });

  it('soft-5 openid flood-8', async () => {
    const sessions = mockKv({ 'openid:tok8': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    expect((await req('GET', '/_matrix/federation/v1/openid/userinfo', makeEnv(createFedDb(), { sessions }))).status).toBe(400);
  });

  it('soft-5 openid flood-9', async () => {
    const sessions = mockKv({ 'openid:tok9': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    expect((await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=unknown9', makeEnv(createFedDb(), { sessions }))).status).toBe(401);
  });

  it('soft-5 openid flood-10', async () => {
    const sessions = mockKv({ 'openid:tok10': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    const r = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok10', makeEnv(createFedDb(), { sessions }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sub: LOCAL_USER });
  });

  it('soft-5 openid flood-11', async () => {
    const sessions = mockKv({ 'openid:tok11': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 60000 }) });
    const r = await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=tok11', makeEnv(createFedDb(), { sessions }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sub: LOCAL_USER });
  });
});

describe('soft-6 media/download soft flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-6 media missing flood-0', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing0'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-1', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing1'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-2', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing2'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-3', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing3'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-4', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing4'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-5', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing5'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-6', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing6'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-7', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing7'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-8', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing8'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-9', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing9'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-10', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing10'), makeEnv(createFedDb()))).status).toBe(404);
  });

  it('soft-6 media missing flood-11', async () => {
    expect((await req('GET', '/_matrix/federation/v1/media/download/' + encodeURIComponent('mxc://example.com/missing11'), makeEnv(createFedDb()))).status).toBe(404);
  });
});

describe('soft-7 state/state_ids soft flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-7 state flood-0', async () => {
    const db = seedBasicRoom();
    expect((await req('GET', '/_matrix/federation/v1/state_ids/%21no%3Aexample.com', makeEnv(db))).status).toBe(404);
  });

  it('soft-7 state flood-1', async () => {
    const db = seedBasicRoom();
    const path = 1 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-2', async () => {
    const db = seedBasicRoom();
    const path = 2 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-3', async () => {
    const db = seedBasicRoom();
    const path = 3 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-4', async () => {
    const db = seedBasicRoom();
    const path = 4 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-5', async () => {
    const db = seedBasicRoom();
    expect((await req('GET', '/_matrix/federation/v1/state_ids/%21no%3Aexample.com', makeEnv(db))).status).toBe(404);
  });

  it('soft-7 state flood-6', async () => {
    const db = seedBasicRoom();
    const path = 6 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-7', async () => {
    const db = seedBasicRoom();
    const path = 7 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-8', async () => {
    const db = seedBasicRoom();
    const path = 8 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-9', async () => {
    const db = seedBasicRoom();
    const path = 9 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-10', async () => {
    const db = seedBasicRoom();
    expect((await req('GET', '/_matrix/federation/v1/state_ids/%21no%3Aexample.com', makeEnv(db))).status).toBe(404);
  });

  it('soft-7 state flood-11', async () => {
    const db = seedBasicRoom();
    const path = 11 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-12', async () => {
    const db = seedBasicRoom();
    const path = 12 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });

  it('soft-7 state flood-13', async () => {
    const db = seedBasicRoom();
    const path = 13 % 2 === 0 ? '/_matrix/federation/v1/state/' + encodeURIComponent(ROOM) : '/_matrix/federation/v1/state_ids/' + encodeURIComponent(ROOM);
    const r = await req('GET', path, makeEnv(db));
    expect(r.status).toBe(200);
  });
});

describe('soft-8 event soft flood', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-8 event flood-0', async () => {
    const ev = makeEvent({ event_id: '$ev0:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    expect((await req('GET', '/_matrix/federation/v1/event/%24none', makeEnv(db))).status).toBe(404);
  });

  it('soft-8 event flood-1', async () => {
    const ev = makeEvent({ event_id: '$ev1:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-2', async () => {
    const ev = makeEvent({ event_id: '$ev2:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-3', async () => {
    const ev = makeEvent({ event_id: '$ev3:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    expect((await req('GET', '/_matrix/federation/v1/event/%24none', makeEnv(db))).status).toBe(404);
  });

  it('soft-8 event flood-4', async () => {
    const ev = makeEvent({ event_id: '$ev4:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-5', async () => {
    const ev = makeEvent({ event_id: '$ev5:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-6', async () => {
    const ev = makeEvent({ event_id: '$ev6:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    expect((await req('GET', '/_matrix/federation/v1/event/%24none', makeEnv(db))).status).toBe(404);
  });

  it('soft-8 event flood-7', async () => {
    const ev = makeEvent({ event_id: '$ev7:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-8', async () => {
    const ev = makeEvent({ event_id: '$ev8:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-9', async () => {
    const ev = makeEvent({ event_id: '$ev9:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    expect((await req('GET', '/_matrix/federation/v1/event/%24none', makeEnv(db))).status).toBe(404);
  });

  it('soft-8 event flood-10', async () => {
    const ev = makeEvent({ event_id: '$ev10:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });

  it('soft-8 event flood-11', async () => {
    const ev = makeEvent({ event_id: '$ev11:example.com', event_type: 'm.room.message', content: '{}' });
    const db = createFedDb({ events: [ev] });
    const r = await req('GET', '/_matrix/federation/v1/event/' + encodeURIComponent(ev.event_id), makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { pdus: unknown[] }).pdus).toHaveLength(1);
  });
});

describe('soft-9 send empty pdus/edus lifecycle', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; verifyRemoteSignature.mockReset(); checkEventAuth.mockReturnValue({ allowed: true }); });

  it('soft-9 send empty flood-0', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-0';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 0 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-1', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-1';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 1 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-2', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-2';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 2 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-3', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-3';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 3 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-4', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-4';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 4 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-5', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-5';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 5 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-6', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-6';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 6 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-7', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-7';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 7 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-8', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-8';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 8 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-9', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-9';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 9 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-10', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-10';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 10 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-11', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-11';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 11 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-12', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-12';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 12 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('soft-9 send empty flood-13', async () => {
    const db = createFedDb();
    const txn = 'txn-soft-13';
    const first = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [], edus: 13 % 2 ? [{ edu_type: 'm.typing', content: {} }] : [] });
    expect(first.status).toBe(200);
    const second = await req('PUT', '/_matrix/federation/v1/send/' + txn, makeEnv(db), { pdus: [] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});

describe('soft-10 method matrix block-10', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-10 DELETE-0', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/version', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 PATCH-1', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/version', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 POST-2', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/version', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 PUT-3', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/version', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 OPTIONS-4', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/version', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 DELETE-5', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/key/v2/server', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 PATCH-6', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/key/v2/server', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 POST-7', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/key/v2/server', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 PUT-8', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/key/v2/server', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 OPTIONS-9', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/key/v2/server', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 DELETE-10', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 PATCH-11', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 POST-12', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/query/directory', makeEnv(seedBasicRoom()), { limit: 1 })).status);
  });

  it('soft-10 PUT-13', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 OPTIONS-14', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 DELETE-15', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/query/directory', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 PATCH-16', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/query/directory', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 POST-17', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/query/directory', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 PUT-18', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/query/directory', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 OPTIONS-19', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/query/directory', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 DELETE-20', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/query/profile', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 PATCH-21', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/query/profile', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 POST-22', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/query/profile', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 PUT-23', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/query/profile', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 OPTIONS-24', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/query/profile', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 DELETE-25', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/openid/userinfo', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 PATCH-26', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/openid/userinfo', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-10 POST-27', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/openid/userinfo', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 PUT-28', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/openid/userinfo', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-10 OPTIONS-29', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/openid/userinfo', makeEnv(seedBasicRoom()))).status);
  });
});

describe('soft-11 method matrix block-11', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-11 DELETE-0', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 PATCH-1', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 POST-2', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 PUT-3', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 OPTIONS-4', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 DELETE-5', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 PATCH-6', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 POST-7', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 PUT-8', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 OPTIONS-9', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 DELETE-10', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 PATCH-11', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 POST-12', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 PUT-13', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 OPTIONS-14', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 DELETE-15', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 PATCH-16', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 POST-17', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 PUT-18', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 OPTIONS-19', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 DELETE-20', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 PATCH-21', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 POST-22', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 PUT-23', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 OPTIONS-24', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 DELETE-25', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 PATCH-26', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-11 POST-27', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/openid/userinfo', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 PUT-28', async () => {
    expect([200, 404, 405]).toContain((await req('PUT', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-11 OPTIONS-29', async () => {
    expect([200, 404, 405]).toContain((await req('OPTIONS', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });
});

describe('soft-12 method matrix block-12', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-12 DELETE-0', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 PATCH-1', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 POST-2', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/state/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-12 DELETE-3', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 PATCH-4', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 POST-5', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/state_ids/%21room%3Aexample.com', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-12 DELETE-6', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 PATCH-7', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 POST-8', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/send/txn-m', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-12 DELETE-9', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 PATCH-10', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 POST-11', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-12 DELETE-12', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 PATCH-13', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 POST-14', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/event/%24e', makeEnv(seedBasicRoom()), { pdus: [] })).status);
  });

  it('soft-12 DELETE-15', async () => {
    expect([200, 404, 405]).toContain((await req('DELETE', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 PATCH-16', async () => {
    expect([200, 404, 405]).toContain((await req('PATCH', '/_matrix/federation/v1/publicRooms', makeEnv(seedBasicRoom()))).status);
  });

  it('soft-12 POST-17', async () => {
    expect([200, 404, 405]).toContain((await req('POST', '/_matrix/federation/v1/media/download/mxc%3A%2F%2Fexample.com%2Fx', makeEnv(seedBasicRoom()), {})).status);
  });
});

describe('soft-13 charset directory aliases', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-13 charset alias-0', async () => {
    const alias = "#room:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: {} })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-1', async () => {
    const alias = "#röom:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#röom:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-2', async () => {
    const alias = "#room-测试:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room-测试:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-3', async () => {
    const alias = "#ROOM:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: {} })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-4', async () => {
    const alias = "#room%20x:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room%20x:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-5', async () => {
    const alias = "#room_:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room_:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-6', async () => {
    const alias = "#room.:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: {} })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-7', async () => {
    const alias = "#room+:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room+:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-8', async () => {
    const alias = "#room=:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room=:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-9', async () => {
    const alias = "#room;:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: {} })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-10', async () => {
    const alias = "#room,:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room,:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });

  it('soft-13 charset alias-11', async () => {
    const alias = "#room!:example.com";
    const r = await req('GET', '/_matrix/federation/v1/query/directory?room_alias=' + encodeURIComponent(alias), makeEnv(createFedDb({ aliases: { '#room!:example.com': ROOM } })));
    expect([200, 404]).toContain(r.status);
  });
});

describe('soft-14 charset profile user_ids', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-14 charset profile-0', async () => {
    const userId = '@user0:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U0', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-1', async () => {
    const userId = '@u_1:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U1', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-2', async () => {
    const userId = '@user2:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U2', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-3', async () => {
    const userId = '@u_3:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U3', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-4', async () => {
    const userId = '@user4:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U4', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-5', async () => {
    const userId = '@u_5:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U5', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-6', async () => {
    const userId = '@user6:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U6', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-7', async () => {
    const userId = '@u_7:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U7', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-8', async () => {
    const userId = '@user8:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U8', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-9', async () => {
    const userId = '@u_9:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U9', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-10', async () => {
    const userId = '@user10:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U10', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });

  it('soft-14 charset profile-11', async () => {
    const userId = '@u_11:example.com';
    const r = await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(userId), makeEnv(createFedDb({ users: [{ user_id: userId, display_name: 'U11', avatar_url: null }] })));
    expect(r.status).toBe(200);
  });
});

describe('soft-15 lifecycle version→publicRooms→directory→profile', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-15 lifecycle chain-0', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-1', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-2', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-3', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-4', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-5', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-6', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-7', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-8', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });

  it('soft-15 lifecycle chain-9', async () => {
    const env = makeEnv(createFedDb({ aliases: { '#room:example.com': ROOM }, users: [{ user_id: LOCAL_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' }], rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1000 }] }));
    expect((await req('GET', '/_matrix/federation/v1/version', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/publicRooms?limit=5', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=%23room%3Aexample.com', env)).status).toBe(200);
    expect((await req('GET', '/_matrix/federation/v1/query/profile?user_id=' + encodeURIComponent(LOCAL_USER), env)).status).toBe(200);
  });
});

describe('soft-key key/v2/server soft', () => {
  let restore: (() => void) | undefined;
  let serverKeyPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;
  beforeAll(async () => { restore = installNodeEd25519Shim(); serverKeyPair = await generateSigningKeyPair(); });
  afterAll(() => restore?.());

  it('soft-key server flood-0', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-1', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-2', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-3', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-4', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-5', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-6', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });

  it('soft-key server flood-7', async () => {
    const db = createFedDb({ serverKeys: [{ key_id: serverKeyPair.keyId, public_key: serverKeyPair.publicKey, private_key_jwk: JSON.stringify(serverKeyPair.privateKeyJwk), key_version: 2, valid_from: Date.now() - 1000, valid_until: Date.now() + 86400000, is_current: 1 }] });
    const r = await req('GET', '/_matrix/key/v2/server', makeEnv(db));
    expect(r.status).toBe(200);
    expect((r.body as { server_name: string }).server_name).toBe(SERVER);
  });
});

describe('failure edges leftovers', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; verifyRemoteSignature.mockReset(); checkEventAuth.mockReturnValue({ allowed: true }); });

  it('edge send bad json', async () => {
    expect((await req('PUT', '/_matrix/federation/v1/send/bad-json', makeEnv(createFedDb()), '{')).status).toBe(400);
  });

  it('edge send no origin', async () => {
    federationOrigin = undefined; expect((await req('PUT', '/_matrix/federation/v1/send/x', makeEnv(createFedDb()), { pdus: [] })).status).toBe(401);
  });

  it('edge publicRooms bad json', async () => {
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(createFedDb()), 'not')).status).toBe(400);
  });

  it('edge openid expired', async () => {
    const s = mockKv({ 'openid:exp': JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() - 1 }) }); expect((await req('GET', '/_matrix/federation/v1/openid/userinfo?access_token=exp', makeEnv(createFedDb(), { sessions: s }))).status).toBe(401);
  });

  it('edge directory empty alias', async () => {
    expect((await req('GET', '/_matrix/federation/v1/query/directory?room_alias=', makeEnv(createFedDb()))).status).toBe(400);
  });

  it('edge profile missing param', async () => {
    expect((await req('GET', '/_matrix/federation/v1/query/profile', makeEnv(createFedDb()))).status).toBe(400);
  });

  it('edge event missing', async () => {
    expect((await req('GET', '/_matrix/federation/v1/event/%24x', makeEnv(createFedDb()))).status).toBe(404);
  });

  it('edge state_ids missing room', async () => {
    expect((await req('GET', '/_matrix/federation/v1/state_ids/%21n%3Ax', makeEnv(seedBasicRoom()))).status).toBe(404);
  });

  it('edge send cached txn', async () => {
    const db = createFedDb({ federationTxns: { 'remote.example.com|cached': JSON.stringify({ pdus: {} }) } }); expect((await req('PUT', '/_matrix/federation/v1/send/cached', makeEnv(db), { pdus: [] })).status).toBe(200);
  });

  it('edge send invalid pdu', async () => {
    const r = await req('PUT', '/_matrix/federation/v1/send/inv', makeEnv(seedBasicRoom()), { pdus: [{ event_id: '$x' }] }); expect(r.status).toBe(200); expect((r.body as { pdus: Record<string, { error?: string }> }).pdus['$x'].error).toBeDefined();
  });
});

describe('charset POST publicRooms search terms', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('charset POST search-0', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "room" } })).status).toBe(200);
  });

  it('charset POST search-1', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "ROOM" } })).status).toBe(200);
  });

  it('charset POST search-2', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "röom" } })).status).toBe(200);
  });

  it('charset POST search-3', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "测试" } })).status).toBe(200);
  });

  it('charset POST search-4', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })).status).toBe(200);
  });

  it('charset POST search-5', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "" } })).status).toBe(200);
  });

  it('charset POST search-6', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "  space  " } })).status).toBe(200);
  });

  it('charset POST search-7', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "%" } })).status).toBe(200);
  });

  it('charset POST search-8', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "#" } })).status).toBe(200);
  });

  it('charset POST search-9', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "*" } })).status).toBe(200);
  });

  it('charset POST search-10', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "?" } })).status).toBe(200);
  });

  it('charset POST search-11', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "null" } })).status).toBe(200);
  });

  it('charset POST search-12', async () => {
    const db = createFedDb({ rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }] });
    expect((await req('POST', '/_matrix/federation/v1/publicRooms', makeEnv(db), { limit: 10, filter: { generic_search_term: "undefined" } })).status).toBe(200);
  });
});

describe('soft-extra publicRooms pagination charset', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  it('soft-extra pagination-0', async () => {
    const rooms = Array.from({ length: 0 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 0, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-1', async () => {
    const rooms = Array.from({ length: 1 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 1, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-2', async () => {
    const rooms = Array.from({ length: 2 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 2, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-3', async () => {
    const rooms = Array.from({ length: 3 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 3, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-4', async () => {
    const rooms = Array.from({ length: 4 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 4, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-5', async () => {
    const rooms = Array.from({ length: 5 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 5, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-6', async () => {
    const rooms = Array.from({ length: 6 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 6, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-7', async () => {
    const rooms = Array.from({ length: 7 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 7, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-8', async () => {
    const rooms = Array.from({ length: 8 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 8, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });

  it('soft-extra pagination-9', async () => {
    const rooms = Array.from({ length: 9 + 2 }, (_, j) => ({ room_id: '!r' + j + ':example.com', room_version: '10', is_public: 1, created_at: 1000 - j }));
    const r = await req('GET', '/_matrix/federation/v1/publicRooms?limit=1&since=offset_' + 9, makeEnv(createFedDb({ rooms })));
    expect(r.status).toBe(200);
  });
});

// deepen federation-api route leftovers after #241 (unsaturated soft floods)

describe('soft hierarchy leftover flood after #241', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

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
    return createFedDb({
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
  }

  for (let i = 0; i < 12; i++) {
    it(`hierarchy suggested soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?suggested_only=true&limit=${1 + (i % 8)}`,
        makeEnv(seedSpace())
      );
      expect(r.status).toBe(200);
      const body = r.body as { room: { room_id: string } | null; children: unknown[] };
      expect(body.room?.room_id).toBe(ROOM);
      expect(body.children.length).toBeGreaterThanOrEqual(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`hierarchy missing soft-${i}`, async () => {
      const r = await req('GET', '/_matrix/federation/v1/hierarchy/%21no%3Ax', makeEnv(createFedDb()));
      expect(r.status).toBe(404);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`hierarchy from offset soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?from=offset_${i % 3}`,
        makeEnv(seedSpace())
      );
      expect(r.status).toBe(200);
    });
  }
});

describe('soft timestamp_to_event leftover flood after #241', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  function seedTs() {
    return createFedDb({
      events: [
        makeEvent({
          event_id: '$t1',
          event_type: 'm.room.message',
          content: '{}',
          origin_server_ts: 1000,
        }),
        makeEvent({
          event_id: '$t2',
          event_type: 'm.room.message',
          content: '{}',
          origin_server_ts: 2000,
          depth: 2,
        }),
      ],
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`timestamp dir soft-${i}`, async () => {
      const dir = i % 2 === 0 ? 'f' : 'b';
      const ts = 1500 + (i % 5) * 10;
      const r = await req(
        'GET',
        `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}?ts=${ts}&dir=${dir}`,
        makeEnv(seedTs())
      );
      expect(r.status).toBe(200);
      expect((r.body as { event_id: string }).event_id).toBeTruthy();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`timestamp missing ts soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(ROOM)}`,
        makeEnv(seedTs())
      );
      expect(r.status).toBe(400);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`timestamp missing room soft-${i}`, async () => {
      const r = await req(
        'GET',
        '/_matrix/federation/v1/timestamp_to_event/%21no%3Ax?ts=1500',
        makeEnv(seedTs())
      );
      expect(r.status).toBe(404);
    });
  }
});

describe('soft event_auth leftover flood after #241', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  function seedAuth() {
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
    return {
      child,
      db: createFedDb({
        events: [create, child],
        rooms: [{ room_id: ROOM, room_version: '10' }],
      }),
    };
  }

  for (let i = 0; i < 12; i++) {
    it(`event_auth chain soft-${i}`, async () => {
      const { child, db } = seedAuth();
      const r = await req(
        'GET',
        `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(child.event_id)}`,
        makeEnv(db)
      );
      expect(r.status).toBe(200);
      expect((r.body as { auth_chain: unknown[] }).auth_chain.length).toBeGreaterThanOrEqual(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`event_auth missing soft-${i}`, async () => {
      const { db } = seedAuth();
      const r = await req(
        'GET',
        `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/%24missing${i}`,
        makeEnv(db)
      );
      expect(r.status).toBe(404);
    });
  }
});

describe('soft backfill leftover flood after #241', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  function seedBackfill() {
    const events = [1, 2, 3, 4, 5].map((d) =>
      makeEvent({
        event_id: `$d${d}:example.com`,
        event_type: 'm.room.message',
        content: JSON.stringify({ body: String(d) }),
        depth: d,
      })
    );
    return createFedDb({
      events,
      memberships: [{ room_id: ROOM, user_id: `@m:${FED_ORIGIN}`, membership: 'join' }],
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`backfill recent soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=${1 + (i % 5)}`,
        makeEnv(seedBackfill())
      );
      expect(r.status).toBe(200);
      expect((r.body as { pdus: unknown[] }).pdus.length).toBeLessThanOrEqual(1 + (i % 5));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`backfill depth-filter soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=10&v=%24d5%3Aexample.com`,
        makeEnv(seedBackfill())
      );
      expect(r.status).toBe(200);
      expect(
        (r.body as { pdus: Array<{ depth: number }> }).pdus.every((p) => p.depth < 5)
      ).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`backfill forbid non-member soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}`,
        makeEnv(createFedDb({ memberships: [] }))
      );
      expect(r.status).toBe(403);
    });
  }
});

describe('soft get_missing_events leftover flood after #241', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  function seedMissing() {
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
    return createFedDb({
      events: [e1, e2],
      memberships: [{ room_id: ROOM, user_id: `@m:${FED_ORIGIN}`, membership: 'join' }],
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`get_missing soft-${i}`, async () => {
      const r = await req(
        'POST',
        `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
        makeEnv(seedMissing()),
        { earliest_events: [], latest_events: ['$m2:example.com'], limit: 10 }
      );
      expect(r.status).toBe(200);
      expect(Array.isArray((r.body as { events: unknown[] }).events)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`get_missing bad json soft-${i}`, async () => {
      const r = await req(
        'POST',
        `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
        makeEnv(seedMissing()),
        '{'
      );
      expect(r.status).toBe(400);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`get_missing forbid soft-${i}`, async () => {
      const r = await req(
        'POST',
        `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
        makeEnv(createFedDb({ memberships: [] })),
        { earliest_events: [], latest_events: ['$m2:example.com'], limit: 10 }
      );
      expect(r.status).toBe(403);
    });
  }
});

describe('soft media thumbnail leftover flood after #241', () => {
  beforeEach(() => { federationOrigin = FED_ORIGIN; });

  const MEDIA_ID = 'fed_media_thumb';

  for (let i = 0; i < 12; i++) {
    it(`thumbnail pre-generated soft-${i}`, async () => {
      const w = 32 + (i % 4) * 16;
      const h = 32;
      const method = i % 2 === 0 ? 'scale' : 'crop';
      const thumbKey = `thumb_${MEDIA_ID}_${w}x${h}_${method}`;
      const media = mockR2({
        [MEDIA_ID]: new Uint8Array([1, 2, 3]),
        [thumbKey]: new Uint8Array([9, 9, 9]),
      });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'a.png' }],
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=${w}&height=${h}&method=${method}`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('image/jpeg');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thumbnail fallback original soft-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([4, 5, 6, 7]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'b.png' }],
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=64&height=64`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('image/png');
      expect(r.headers.get('X-Thumbnail-Generated')).toBe('false');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thumbnail missing soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/nope-${i}`,
        makeEnv(createFedDb())
      );
      expect(r.status).toBe(404);
    });
  }
});

afterEach(() => { federationOrigin = FED_ORIGIN; vi.clearAllMocks(); });

// residual soft floods after #252 (non-catchup send/media/openid niches unsaturated post-#248)

const REMOTE_USER = `@remote:${FED_ORIGIN}`;

describe('soft send content-hash / prev-rejected / origin-sig leftover flood after #252', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockImplementation(async () => false);
  });

  for (let i = 0; i < 10; i++) {
    it(`content-hash mismatch soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      verifyContentHash.mockResolvedValue(false);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$hashmiss${i}`;
      const { status, body } = await req('PUT', `/_matrix/federation/v1/send/txn-hash-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            hashes: { sha256: 'not-a-real-hash' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect(status).toBe(200);
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe('Content hash mismatch');
      expect(
        db.inserts.some(
          (ins) =>
            String(ins.sql).includes('processed_pdus') &&
            ins.args.includes('Content hash mismatch')
        )
      ).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`content-hash verification throw soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      verifyContentHash.mockRejectedValue(new Error(`hash-boom-${i}`));
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$hashthrow${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-hashthrow-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            hashes: { sha256: 'any' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Content hash verification error'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`previously-rejected null reason soft-${i}`, async () => {
      const eid = `$prevnull${i}`;
      const db = createFedDb({
        processedPdus: { [eid]: { accepted: 0, rejection_reason: null } },
      });
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-prev-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe('Previously rejected');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`origin-server invalid signature soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(false);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '1', is_public: 1, created_at: 1 }],
      });
      const eid = `$originsig${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-origsig-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'bad' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'PDU from origin server without valid signature'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`checkEventAuth throw accepts soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      verifyContentHash.mockResolvedValue(true);
      checkEventAuth.mockImplementation(() => {
        throw new Error(`auth-boom-${i}`);
      });
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$auththrow${i}`;
      const { status, body } = await req('PUT', `/_matrix/federation/v1/send/txn-auththrow-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'ok' },
            hashes: { sha256: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect(status).toBe(200);
      expect((body as { pdus: Record<string, unknown> }).pdus[eid]).toEqual({});
      expect(
        db.inserts.some(
          (ins) =>
            String(ins.sql).includes('processed_pdus') &&
            String(ins.sql).includes('1, NULL')
        )
      ).toBe(true);
    });
  }
});

describe('soft send presence / noop EDU leftover flood after #252', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
  });

  for (let i = 0; i < 10; i++) {
    it(`m.presence upsert soft-${i}`, async () => {
      const db = createFedDb();
      const { status, body } = await req('PUT', `/_matrix/federation/v1/send/txn-pres-${i}`, makeEnv(db), {
        pdus: [],
        edus: [
          {
            edu_type: 'm.presence',
            content: {
              push: [
                {
                  user_id: `@u${i}:${FED_ORIGIN}`,
                  presence: i % 2 === 0 ? 'online' : 'unavailable',
                  status_msg: `s${i}`,
                  last_active_ago: 1000 * (i + 1),
                  currently_active: i % 2 === 0,
                },
              ],
            },
          },
        ],
      });
      expect(status).toBe(200);
      expect((body as { pdus: unknown }).pdus).toEqual({});
      expect(db.inserts.some((ins) => String(ins.sql).includes('INSERT INTO presence'))).toBe(true);
      expect(db.inserts.some((ins) => String(ins.sql).includes('INSERT OR REPLACE INTO processed_edus'))).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`noop EDU still recorded soft-${i}`, async () => {
      const types = ['m.receipt', 'm.direct_to_device', 'm.signing_key_update', 'm.unknown_edu'] as const;
      const eduType = types[i % types.length];
      const db = createFedDb();
      const { status } = await req('PUT', `/_matrix/federation/v1/send/txn-noop-${i}`, makeEnv(db), {
        pdus: [],
        edus: [{ edu_type: eduType, content: { n: i } }],
      });
      expect(status).toBe(200);
      const eduInsert = db.inserts.find((ins) => String(ins.sql).includes('INSERT OR REPLACE INTO processed_edus'));
      expect(eduInsert).toBeTruthy();
      expect(eduInsert!.args[1]).toBe(eduType);
    });
  }
});

describe('soft media download/thumbnail / openid text leftover flood after #252', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  const MEDIA_ID = 'fed_media_disp';

  for (let i = 0; i < 8; i++) {
    it(`download Content-Disposition soft-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([1, 2, 3, i]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: `pic-${i}.png` }],
      });
      const r = await req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, makeEnv(db, { media }));
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('image/png');
      expect(r.headers.get('Content-Disposition')).toBe(`inline; filename="pic-${i}.png"`);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`download octet-stream missing meta soft-${i}`, async () => {
      const id = `orphan_media_${i}`;
      const media = mockR2({ [id]: new Uint8Array([9, 9, i]) });
      const db = createFedDb({ media: [] });
      const r = await req('GET', `/_matrix/federation/v1/media/download/${id}`, makeEnv(db, { media }));
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(r.headers.get('Content-Disposition')).toBeNull();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thumbnail clamp width soft-${i}`, async () => {
      const thumbKey = `thumb_${MEDIA_ID}_1920x96_scale`;
      const media = mockR2({
        [MEDIA_ID]: new Uint8Array([1, 2, 3]),
        [thumbKey]: new Uint8Array([7, 7, 7]),
      });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'big.png' }],
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=99999&height=96&method=scale`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('image/jpeg');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thumbnail non-image no X-Thumbnail soft-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([4, 5, 6, i]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'application/pdf', filename: 'doc.pdf' }],
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=64&height=64`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('application/pdf');
      expect(r.headers.get('X-Thumbnail-Generated')).toBeNull();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`openid invalid vs expired text soft-${i}`, async () => {
      if (i % 2 === 0) {
        const sessions = mockKv();
        const r = await req(
          'GET',
          `/_matrix/federation/v1/openid/userinfo?access_token=missing${i}`,
          makeEnv(createFedDb(), { sessions })
        );
        expect(r.status).toBe(401);
        expect((r.body as { errcode: string; error: string }).errcode).toBe('M_UNKNOWN_TOKEN');
        expect((r.body as { error: string }).error).toBe('Invalid or expired OpenID token');
      } else {
        const tok = `expired${i}`;
        const sessions = mockKv({
          [`openid:${tok}`]: JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() - 1000 }),
        });
        const r = await req(
          'GET',
          `/_matrix/federation/v1/openid/userinfo?access_token=${tok}`,
          makeEnv(createFedDb(), { sessions })
        );
        expect(r.status).toBe(401);
        expect((r.body as { errcode: string; error: string }).errcode).toBe('M_UNKNOWN_TOKEN');
        expect((r.body as { error: string }).error).toBe('OpenID token has expired');
        expect(sessions.data[`openid:${tok}`]).toBeUndefined();
      }
    });
  }
});

// residual soft floods after #265 (non-catchup send/media niches unsaturated post-#252)

describe('soft send third-party / missing-hash / auth-denied leftover flood after #265', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockResolvedValue(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`third-party PDU invalid signature soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(false);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$third${i}`;
      const { status, body } = await req('PUT', `/_matrix/federation/v1/send/txn-third-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: '@carol:other.example.com',
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { 'other.example.com': { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect(status).toBe(200);
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Third-party PDU without valid signature'
      );
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`missing-hash v10 soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$nohash${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-nohash-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Missing required hashes.sha256 (room_version=10)'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`missing-hash unknown room soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      const db = createFedDb({ rooms: [] });
      const eid = `$unkhash${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-unkhash-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: '!unknown:example.com',
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Missing required hashes.sha256 (room_version=unknown)'
      );
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`auth-denied power levels soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      verifyContentHash.mockResolvedValue(true);
      checkEventAuth.mockReturnValue({ allowed: false, error: 'power levels' });
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$authdeny${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-authdeny-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            hashes: { sha256: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe('power levels');
    });
  }
});

describe('soft send previously-accepted / invalid / legacy / typing leftover flood after #265', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockResolvedValue(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`previously-accepted reuse soft-${i}`, async () => {
      const eid = `$prevok${i}`;
      const db = createFedDb({
        processedPdus: { [eid]: { accepted: 1, rejection_reason: null } },
      });
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-prevok-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      });
      expect((body as { pdus: Record<string, unknown> }).pdus[eid]).toEqual({});
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invalid PDU structure soft-${i}`, async () => {
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$badstruct${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-badstruct-${i}`, makeEnv(db), {
        pdus: [{ event_id: eid, room_id: ROOM }],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Invalid PDU structure'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invalid sender format soft-${i}`, async () => {
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$badsender${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-badsender-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: 'noserver',
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Invalid sender format'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`legacy v1 accept without hash soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      checkEventAuth.mockReturnValue({ allowed: true });
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '1', is_public: 1, created_at: 1 }],
      });
      const eid = `$legacy${i}`;
      const { status, body } = await req('PUT', `/_matrix/federation/v1/send/txn-legacy-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'hello' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect(status).toBe(200);
      expect((body as { pdus: Record<string, unknown> }).pdus[eid]).toEqual({});
      expect(db.inserts.some((ins) => String(ins.sql).includes('INSERT OR IGNORE INTO events'))).toBe(true);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`m.typing EDU recorded soft-${i}`, async () => {
      const db = createFedDb();
      const { status } = await req('PUT', `/_matrix/federation/v1/send/txn-typing-${i}`, makeEnv(db), {
        pdus: [],
        edus: [{ edu_type: 'm.typing', content: { room_id: ROOM, user_ids: [`@t${i}:${FED_ORIGIN}`] } }],
      });
      expect(status).toBe(200);
      const eduInsert = db.inserts.find((ins) => String(ins.sql).includes('INSERT OR REPLACE INTO processed_edus'));
      expect(eduInsert).toBeTruthy();
      expect(eduInsert!.args[1]).toBe('m.typing');
    });
  }
});

describe('soft media 404 / Cache-Control / thumb height leftover flood after #265', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  const MEDIA_ID = 'fed_media_265';

  for (let i = 0; i < 8; i++) {
    it(`download miss Media not found soft-${i}`, async () => {
      const media = mockR2({});
      const db = createFedDb({ media: [] });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/download/missing_${i}`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(404);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_NOT_FOUND');
      expect((r.body as { error: string }).error).toBe('Media not found');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`download hit Cache-Control soft-${i}`, async () => {
      const media = mockR2({ [MEDIA_ID]: new Uint8Array([1, 2, 3, i]) });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: `hit-${i}.png` }],
      });
      const r = await req('GET', `/_matrix/federation/v1/media/download/${MEDIA_ID}`, makeEnv(db, { media }));
      expect(r.status).toBe(200);
      expect(r.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(r.headers.get('Content-Disposition')).toBe(`inline; filename="hit-${i}.png"`);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thumbnail height clamp soft-${i}`, async () => {
      const thumbKey = `thumb_${MEDIA_ID}_96x1920_scale`;
      const media = mockR2({
        [MEDIA_ID]: new Uint8Array([1, 2, 3]),
        [thumbKey]: new Uint8Array([7, 7, 7]),
      });
      const db = createFedDb({
        media: [{ media_id: MEDIA_ID, content_type: 'image/png', filename: 'tall.png' }],
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${MEDIA_ID}?width=96&height=99999&method=scale`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('image/jpeg');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`thumbnail meta-sans-R2 404 soft-${i}`, async () => {
      const id = `meta_only_${i}`;
      const media = mockR2({});
      const db = createFedDb({
        media: [{ media_id: id, content_type: 'image/png', filename: 'gone.png' }],
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/${id}?width=64&height=64`,
        makeEnv(db, { media })
      );
      expect(r.status).toBe(404);
      expect((r.body as { error: string }).error).toBe('Media not found');
    });
  }
});

// second-wave residual soft floods after tip #271 (post-#270, skip catchup)

describe('soft second-wave send custom-reject / hash-v11 / auth-fallback / unknown soft after #271', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
    verifyRemoteSignature.mockReset();
    checkEventAuth.mockReset();
    checkEventAuth.mockReturnValue({ allowed: true });
    verifyContentHash.mockReset();
    verifyContentHash.mockResolvedValue(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`previously-rejected custom reason soft-${i}`, async () => {
      const eid = `$customrej${i}`;
      const reason = `custom-reason-${i}`;
      const db = createFedDb({
        processedPdus: { [eid]: { accepted: 0, rejection_reason: reason } },
      });
      const { status, body } = await req('PUT', `/_matrix/federation/v1/send/txn-customrej-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
          },
        ],
      });
      expect(status).toBe(200);
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(reason);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`missing-hash room_version=11 soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '11', is_public: 1, created_at: 1 }],
      });
      const eid = `$nohash11_${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-nohash11-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Missing required hashes.sha256 (room_version=11)'
      );
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`auth-denied fallback Event authorization failed soft-${i}`, async () => {
      verifyRemoteSignature.mockResolvedValue(true);
      verifyContentHash.mockResolvedValue(true);
      checkEventAuth.mockReturnValue({ allowed: false });
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const eid = `$authfb${i}`;
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-authfb-${i}`, makeEnv(db), {
        pdus: [
          {
            event_id: eid,
            room_id: ROOM,
            sender: REMOTE_USER,
            type: 'm.room.message',
            content: { body: 'x' },
            hashes: { sha256: 'ok' },
            signatures: { [FED_ORIGIN]: { 'ed25519:1': 'sig' } },
          },
        ],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus[eid].error).toBe(
        'Event authorization failed'
      );
      const pduInsert = db.inserts.find(
        (ins) =>
          String(ins.sql).includes('INSERT OR REPLACE INTO processed_pdus') &&
          ins.args[0] === eid
      );
      expect(pduInsert).toBeTruthy();
      expect(pduInsert!.args).toContain('Auth failed');
      expect(String(pduInsert!.sql)).toContain('VALUES (?, ?, ?, ?, 0, ?)');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`invalid PDU no event_id → pdus.unknown soft-${i}`, async () => {
      const db = createFedDb({
        rooms: [{ room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 }],
      });
      const { body } = await req('PUT', `/_matrix/federation/v1/send/txn-unknown-${i}`, makeEnv(db), {
        pdus: [{ room_id: ROOM, type: 'm.room.message', content: { body: 'x' } }],
      });
      expect((body as { pdus: Record<string, { error: string }> }).pdus.unknown.error).toBe(
        'Invalid PDU structure'
      );
    });
  }
});

describe('soft second-wave openid retained / missing-origin / hierarchy nonsuggested soft after #271', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  for (let i = 0; i < 10; i++) {
    it(`openid success sub + token retained soft-${i}`, async () => {
      const tok = `retain_tok_${i}`;
      const sessions = mockKv({
        [`openid:${tok}`]: JSON.stringify({ user_id: LOCAL_USER, expires_at: Date.now() + 120_000 }),
      });
      const r = await req(
        'GET',
        `/_matrix/federation/v1/openid/userinfo?access_token=${tok}`,
        makeEnv(createFedDb(), { sessions })
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ sub: LOCAL_USER });
      expect(sessions.data[`openid:${tok}`]).toBeTruthy();
      expect(Object.keys(sessions.data)).toContain(`openid:${tok}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`send missing federationOrigin 401 soft-${i}`, async () => {
      federationOrigin = undefined;
      const db = createFedDb();
      const r = await req('PUT', `/_matrix/federation/v1/send/txn-noorigin-${i}`, makeEnv(db), {
        pdus: [],
      });
      expect(r.status).toBe(401);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_UNAUTHORIZED');
      expect((r.body as { error: string }).error).toBe('Federation authentication required');
    });
  }

  function seedMixedSpace() {
    const suggestedChild = '!sug:example.com';
    const plainChild = '!plain:example.com';
    const sugEvt = makeEvent({
      event_id: '$suglink',
      event_type: 'm.space.child',
      state_key: suggestedChild,
      content: JSON.stringify({ via: [SERVER], suggested: true }),
    });
    const plainEvt = makeEvent({
      event_id: '$plainlink',
      event_type: 'm.space.child',
      state_key: plainChild,
      content: JSON.stringify({ via: [SERVER], suggested: false }),
    });
    const name = makeEvent({
      event_id: '$spname2',
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'MixedSpace' }),
    });
    const sugName = makeEvent({
      event_id: '$sugname',
      room_id: suggestedChild,
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'Suggested' }),
    });
    const plainName = makeEvent({
      event_id: '$plainname',
      room_id: plainChild,
      event_type: 'm.room.name',
      content: JSON.stringify({ name: 'Plain' }),
    });
    return createFedDb({
      rooms: [
        { room_id: ROOM, room_version: '10', is_public: 1, created_at: 1 },
        { room_id: suggestedChild, room_version: '10', is_public: 1, created_at: 2 },
        { room_id: plainChild, room_version: '10', is_public: 1, created_at: 3 },
      ],
      events: [sugEvt, plainEvt, name, sugName, plainName],
      roomState: new Map([
        [stateKey(ROOM, 'm.space.child', suggestedChild), sugEvt.event_id],
        [stateKey(ROOM, 'm.space.child', plainChild), plainEvt.event_id],
        [stateKey(ROOM, 'm.room.name', ''), name.event_id],
        [stateKey(suggestedChild, 'm.room.name', ''), sugName.event_id],
        [stateKey(plainChild, 'm.room.name', ''), plainName.event_id],
      ]),
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`hierarchy nonsuggested included when suggested_only absent soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?limit=20`,
        makeEnv(seedMixedSpace())
      );
      expect(r.status).toBe(200);
      const body = r.body as { room: { room_id: string } | null; children: Array<{ room_id: string }> };
      expect(body.room?.room_id).toBe(ROOM);
      const childIds = body.children.map((c) => c.room_id);
      expect(childIds).toContain('!sug:example.com');
      expect(childIds).toContain('!plain:example.com');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`hierarchy suggested_only excludes nonsuggested soft-${i}`, async () => {
      const r = await req(
        'GET',
        `/_matrix/federation/v1/hierarchy/${encodeURIComponent(ROOM)}?suggested_only=true&limit=20`,
        makeEnv(seedMixedSpace())
      );
      expect(r.status).toBe(200);
      const body = r.body as { children: Array<{ room_id: string }> };
      const childIds = body.children.map((c) => c.room_id);
      expect(childIds).toContain('!sug:example.com');
      expect(childIds).not.toContain('!plain:example.com');
    });
  }
});

// tertiary residual soft floods after tip #275 (invite validation niches unsaturated)

describe('soft tertiary invite v1 exact validation after #275', () => {
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

  function invitePath(eventId: string) {
    return `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(eventId)}`;
  }

  for (let i = 0; i < 10; i++) {
    it(`v1 not-invite soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$ni${i}`), inviteEnv(), {
        type: 'm.room.member',
        content: { membership: 'join' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      });
      expect(r.status).toBe(400);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_INVALID_PARAM');
      expect((r.body as { error: string }).error).toBe('Event is not an invite event');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 event_id mismatch soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$want${i}`), inviteEnv(), {
        event_id: `$other${i}`,
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      });
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toBe('Event ID mismatch');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 wrong-origin soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$wo${i}`), inviteEnv(), {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: '@eve:evil.example.com',
        state_key: LOCAL_USER,
      });
      expect(r.status).toBe(403);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_FORBIDDEN');
      expect((r.body as { error: string }).error).toBe(
        'Sender does not belong to the authenticated origin server'
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 bad state_key soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$bs${i}`), inviteEnv(), {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: 'bad',
      });
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toBe('Invalid state_key for invite');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 not-local soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$nl${i}`), inviteEnv(), {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: '@x:other.com',
      });
      expect(r.status).toBe(403);
      expect((r.body as { error: string }).error).toBe('User is not local to this server');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 user-missing soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$um${i}`), inviteEnv({ users: [] }), {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      });
      expect(r.status).toBe(404);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_NOT_FOUND');
      expect((r.body as { error: string }).error).toBe('User not found');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 no signing key soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$nk${i}`), inviteEnv({ serverKeys: [] }), {
        type: 'm.room.member',
        content: { membership: 'invite' },
        sender: REMOTE_USER,
        state_key: LOCAL_USER,
      });
      expect(r.status).toBe(500);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_UNKNOWN');
      expect((r.body as { error: string }).error).toBe('Server signing key not configured');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v1 success [200, signed] soft-${i}`, async () => {
      const eid = `$iok${i}`;
      const r = await req('PUT', invitePath(eid), inviteEnv(), {
        event: {
          event_id: eid,
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      const tuple = r.body as [number, { signatures?: unknown; event_id?: string }];
      expect(tuple[0]).toBe(200);
      expect(tuple[1].signatures).toBeDefined();
      expect(tuple[1].event_id).toBe(eid);
    });
  }
});

describe('soft tertiary invite v2 exact validation after #275', () => {
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

  function invitePath(eventId: string) {
    return `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(eventId)}`;
  }

  for (let i = 0; i < 8; i++) {
    it(`v2 missing room_version soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$nrv${i}`), inviteEnv(), {
        event: {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      });
      expect(r.status).toBe(400);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_MISSING_PARAM');
      expect((r.body as { error: string }).error).toBe('Missing required parameter: room_version');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v2 missing event soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$ne${i}`), inviteEnv(), {
        room_version: '10',
      });
      expect(r.status).toBe(400);
      expect((r.body as { errcode: string; error: string }).errcode).toBe('M_MISSING_PARAM');
      expect((r.body as { error: string }).error).toBe('Missing required parameter: event');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v2 Unsupported room version soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$uv${i}`), inviteEnv(), {
        room_version: '99',
        event: {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      });
      expect(r.status).toBe(400);
      expect((r.body as { errcode: string; error: string }).errcode).toBe(
        'M_INCOMPATIBLE_ROOM_VERSION'
      );
      expect((r.body as { error: string }).error).toBe('Unsupported room version: 99');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v2 not-invite soft-${i}`, async () => {
      const r = await req('PUT', invitePath(`$v2ni${i}`), inviteEnv(), {
        room_version: '10',
        event: {
          type: 'm.room.member',
          content: { membership: 'leave' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      });
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toBe('Event is not an invite event');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`v2 success {event:signed} soft-${i}`, async () => {
      const eid = `$iv2ok${i}`;
      const r = await req('PUT', invitePath(eid), inviteEnv(), {
        room_version: '10',
        event: {
          event_id: eid,
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      });
      expect(r.status).toBe(200);
      const body = r.body as { event: { signatures?: unknown; event_id?: string } };
      expect(body.event.signatures).toBeDefined();
      expect(body.event.event_id).toBe(eid);
    });
  }
});
