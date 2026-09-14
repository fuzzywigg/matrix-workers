/**
 * TOKENMAXX HEAVY leftovers after #328 — septenary *federation* soft+concurrent-race
 * niches unsaturated by senary keys-claim/openid/3pid exact (#328 / tip after #336).
 * Skip FederationCatchupWorkflow.
 *
 * Gap table (why leftover after #328 senary):
 *   invite Event is not an invite event soft∥race (v1∥v2)
 *     | first-wave residual only; never quinary/senary soft floods
 *   invite Sender does not belong to authenticated origin
 *     | first-wave race once; never soft flood in this series
 *   invite Invalid state_key for invite
 *     | route leftovers only — zero concurrent soft/race coverage
 *   invite User is not local to this server soft
 *     | first-wave race once; never soft flood in quinary/senary
 *   federation Media not found download∥thumbnail soft
 *     | first-wave once; never soft flood in quinary/senary
 *   Federation authentication required when origin unset
 *     | route leftovers; never soft flood in admin/fed canary series
 *
 * Distinct from #328 senary, #317 quinary, #297 quaternary. Tests-only.
 * example.com only. No invent-product / secrets / DNS / history rewrite.
 * Reversible by deleting this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// Septenary soft floods + concurrent races after tip #328 / post-#336 wave
// ---------------------------------------------------------------------------

const REMOTE_USER = '@remote:remote.example.com';

describe('soft septenary federation invite/media/auth exact after #328', () => {
  for (let i = 0; i < 12; i++) {
    it(`invite v1 Event is not an invite event exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const bodies = [
        {
          type: 'm.room.member',
          content: { membership: 'join' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
        {
          type: 'm.room.message',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        },
      ];
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$ni${i}`)}`,
        env,
        bodies[i % bodies.length]
      );
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_INVALID_PARAM');
      expect((res.body as { error: string }).error).toBe('Event is not an invite event');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`invite v2 Event is not an invite event exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'PUT',
        `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$niv2${i}`)}`,
        env,
        {
          room_version: '10',
          event: {
            type: 'm.room.member',
            content: { membership: 'leave' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          },
        }
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('Event is not an invite event');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`invite Sender does not belong exact flood-${i}`, async () => {
      // v1 only: requireFederationAuth (sets federationOrigin) is mounted on v1/*,
      // so wrong-origin cannot fire on v2 without that middleware.
      const env = makeEnv(createFedDb());
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$wo${i}`)}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: i % 2 === 0 ? '@eve:evil.example.com' : '@mallory:evil.example.com',
          state_key: LOCAL_USER,
        }
      );
      expect(res.status).toBe(403);
      expect((res.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      expect((res.body as { error: string }).error).toBe(
        'Sender does not belong to the authenticated origin server'
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`invite Invalid state_key for invite exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const keys = ['', 'nocolon', null];
      const sk = keys[i % keys.length];
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$sk${i}`)}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: sk,
        }
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('Invalid state_key for invite');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`invite User is not local to this server exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$nl${i}`)}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: `@x${i}:other.example.com`,
        }
      );
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toBe('User is not local to this server');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`media download Media not found exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'GET',
        `/_matrix/federation/v1/media/download/missing-media-${i}`,
        env
      );
      expect(res.status).toBe(404);
      expect((res.body as { errcode: string }).errcode).toBe('M_NOT_FOUND');
      expect((res.body as { error: string }).error).toBe('Media not found');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`media thumbnail Media not found exact flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      const res = await req(
        'GET',
        `/_matrix/federation/v1/media/thumbnail/missing-thumb-${i}?width=64&height=64&method=scale`,
        env
      );
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBe('Media not found');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`Federation authentication required exact flood-${i}`, async () => {
      federationOrigin = undefined;
      const env = makeEnv(createFedDb());
      const res = await req('PUT', `/_matrix/federation/v1/send/txn-noorig-${i}`, env, {
        pdus: [],
        edus: [],
      });
      expect(res.status).toBe(401);
      expect((res.body as { errcode: string }).errcode).toBe('M_UNAUTHORIZED');
      expect((res.body as { error: string }).error).toBe('Federation authentication required');
    });
  }
});

describe('race septenary federation invite/media/auth exact after #328', () => {
  beforeEach(() => {
    federationOrigin = FED_ORIGIN;
  });

  it('invite not-invite∥Invalid state_key isolation', async () => {
    const env = makeEnv(createFedDb());
    const [notInvite, badSk] = await Promise.all([
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
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_sk')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: 'nocolon',
        }
      ),
    ]);
    expect(statusesOf([notInvite, badSk])).toEqual([400, 400]);
    expect((notInvite.body as { error: string }).error).toBe('Event is not an invite event');
    expect((badSk.body as { error: string }).error).toBe('Invalid state_key for invite');
  });

  it('invite wrong-origin∥not-local isolation', async () => {
    const env = makeEnv(createFedDb());
    const [wrong, notLocal] = await Promise.all([
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
      // v1 for not-local too so federationOrigin is set and local-server check runs
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$race_nl')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: '@x:other.example.com',
        }
      ),
    ]);
    expect(statusesOf([wrong, notLocal])).toEqual([403, 403]);
    expect((wrong.body as { error: string }).error).toBe(
      'Sender does not belong to the authenticated origin server'
    );
    expect((notLocal.body as { error: string }).error).toBe('User is not local to this server');
  });

  it('media download∥thumbnail Media not found isolation', async () => {
    const env = makeEnv(createFedDb());
    const [dl, thumb] = await Promise.all([
      req('GET', '/_matrix/federation/v1/media/download/gone-a', env),
      req('GET', '/_matrix/federation/v1/media/thumbnail/gone-b?width=32&height=32', env),
    ]);
    expect(statusesOf([dl, thumb])).toEqual([404, 404]);
    expect((dl.body as { error: string }).error).toBe('Media not found');
    expect((thumb.body as { error: string }).error).toBe('Media not found');
  });

  it('Federation authentication required dual send txn isolation', async () => {
    federationOrigin = undefined;
    const env = makeEnv(createFedDb());
    const [a, b] = await Promise.all([
      req('PUT', '/_matrix/federation/v1/send/txn-dual-a', env, { pdus: [] }),
      req('PUT', '/_matrix/federation/v1/send/txn-dual-b', env, { pdus: [], edus: [] }),
    ]);
    expect(statusesOf([a, b])).toEqual([401, 401]);
    expect((a.body as { error: string }).error).toBe('Federation authentication required');
    expect((b.body as { error: string }).error).toBe('Federation authentication required');
  });

  it('invite not-invite∥Media not found∥auth required triple', async () => {
    const env = makeEnv(createFedDb());
    federationOrigin = undefined;
    const authEnv = makeEnv(createFedDb());
    const [notInvite, media, auth] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$tri_ni')}`,
        env,
        {
          room_version: '10',
          event: {
            type: 'm.room.message',
            content: { membership: 'invite' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          },
        }
      ),
      req('GET', '/_matrix/federation/v1/media/download/tri-miss', env),
      req('PUT', '/_matrix/federation/v1/send/txn-tri-auth', authEnv, { pdus: [] }),
    ]);
    expect(notInvite.status).toBe(400);
    expect((notInvite.body as { error: string }).error).toBe('Event is not an invite event');
    expect(media.status).toBe(404);
    expect((media.body as { error: string }).error).toBe('Media not found');
    expect(auth.status).toBe(401);
    expect((auth.body as { error: string }).error).toBe('Federation authentication required');
  });

  it('Invalid state_key∥wrong-origin∥not-local triple', async () => {
    const env = makeEnv(createFedDb());
    const [badSk, wrong, notLocal] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$t_sk')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: '',
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$t_wo')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: '@eve:evil.example.com',
          state_key: LOCAL_USER,
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$t_nl')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: '@z:elsewhere.example.com',
        }
      ),
    ]);
    expect(badSk.status).toBe(400);
    expect((badSk.body as { error: string }).error).toBe('Invalid state_key for invite');
    expect(wrong.status).toBe(403);
    expect((wrong.body as { error: string }).error).toBe(
      'Sender does not belong to the authenticated origin server'
    );
    expect(notLocal.status).toBe(403);
    expect((notLocal.body as { error: string }).error).toBe('User is not local to this server');
  });

  it('v1∥v2 not-invite dual exact', async () => {
    const env = makeEnv(createFedDb());
    const [v1, v2] = await Promise.all([
      req(
        'PUT',
        `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$dual_v1')}`,
        env,
        {
          type: 'm.room.member',
          content: { membership: 'ban' },
          sender: REMOTE_USER,
          state_key: LOCAL_USER,
        }
      ),
      req(
        'PUT',
        `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent('$dual_v2')}`,
        env,
        {
          room_version: '10',
          event: {
            type: 'm.room.member',
            content: { membership: 'knock' },
            sender: REMOTE_USER,
            state_key: LOCAL_USER,
          },
        }
      ),
    ]);
    expect(statusesOf([v1, v2])).toEqual([400, 400]);
    expect((v1.body as { error: string }).error).toBe('Event is not an invite event');
    expect((v2.body as { error: string }).error).toBe('Event is not an invite event');
  });

  for (let i = 0; i < 12; i++) {
    it(`septenary federation race flood-${i}`, async () => {
      const env = makeEnv(createFedDb());
      federationOrigin = undefined;
      const authEnv = makeEnv(createFedDb());
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
          `/_matrix/federation/v1/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(`$fsk${i}`)}`,
          env,
          {
            type: 'm.room.member',
            content: { membership: 'invite' },
            sender: REMOTE_USER,
            state_key: 'bad',
          }
        ),
        req('GET', `/_matrix/federation/v1/media/download/flood-${i}`, env),
        req('PUT', `/_matrix/federation/v1/send/txn-flood-${i}`, authEnv, { pdus: [] }),
      ]);
      expect(results[0].status).toBe(400);
      expect((results[0].body as { error: string }).error).toBe('Event is not an invite event');
      expect(results[1].status).toBe(400);
      expect((results[1].body as { error: string }).error).toBe('Invalid state_key for invite');
      expect(results[2].status).toBe(404);
      expect((results[2].body as { error: string }).error).toBe('Media not found');
      expect(results[3].status).toBe(401);
      expect((results[3].body as { error: string }).error).toBe(
        'Federation authentication required'
      );
    });
  }
});
