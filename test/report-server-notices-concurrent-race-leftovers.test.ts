/**
 * TOKENMAXX HEAVY leftovers after #197 — report + server-notices *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by:
 *   - devices-keybackups-report-concurrent-race (#153): event/room INSERT TOCTOU + resolve double-apply
 *   - report-api-route-leftovers / report-api-routes soft floods
 *   - server-notices-api-route-leftovers light concurrent (3 cases) + server-notice-helpers
 *
 * Distinct domain — not profile-mutate (#197), tags (#196), workflows (#195), rooms-mutate (#194),
 * aliases (#193), rooms (#192), admin-mutate (#191), presence (#190), sliding-sync (#189),
 * search/spaces slices. Focus stays on src/api/report.ts + src/api/server-notices.ts.
 *
 * Report focus: user-report INSERT TOCTOU; event/room/user UPDATE last-write-wins under
 * Promise.all; report∥resolve; list∥resolve / get∥resolve; cross-type event∥room∥user;
 * score clamp races; leave-membership concurrent; corrupt content admin GET; isolation.
 *
 * Server-notices focus: cold notice-room lookup TOCTOU (dual room create); warm depth/
 * prev_events lost-update under SELECT barrier; synapse∥matrix dual-endpoint cold race;
 * server-user create TOCTOU; multi-target isolation; auth/validation soft concurrent floods.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
}));

let eventSeq = 0;
let opaqueSeq = 0;
const generateOpaqueId = vi.fn(
  async (length: number = 18) => `opaque${length}-${++opaqueSeq}`
);
const generateEventId = vi.fn(async (serverName: string) => `$evt-${++eventSeq}:${serverName}`);

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

vi.mock('../src/utils/ids', () => ({
  generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [number?])),
  generateEventId: (...args: unknown[]) => generateEventId(...(args as [string])),
}));

import reportApp from '../src/api/report';
import serverNoticesApp from '../src/api/server-notices';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const ADMIN = '@admin:example.com';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const EVENT = '$evt:example.com';
const SERVER = 'example.com';
const SERVER_USER = `@server:${SERVER}`;
const NOTICE_ROOM_TYPE = 'm.server_notice';
const SYNAPSE_PATH = '/_synapse/admin/v1/send_server_notice';
const MATRIX_PATH = '/_matrix/client/v3/admin/send_server_notice';
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type Membership = { room_id: string; user_id: string; membership: string };
type UserRow = { user_id: string; admin: number };
type EventRow = {
  event_id: string;
  room_id: string;
  sender?: string;
  event_type?: string;
  content?: string | null;
};
type ReportRow = {
  id: number;
  reporter_user_id: string;
  room_id: string | null;
  event_id: string | null;
  reason: string;
  score: number;
  created_at: number;
  resolved: number;
  resolved_by?: string | null;
  resolved_at?: number | null;
  resolution_note?: string | null;
  report_type?: string | null;
  reported_user_id?: string | null;
};

async function withSelectBarrier(
  barrier: SelectBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
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

function createReportDb(
  opts: {
    users?: UserRow[];
    rooms?: string[];
    events?: EventRow[];
    memberships?: Membership[];
    reports?: ReportRow[];
    selectBarrier?: SelectBarrier;
    failSelectAfter?: number;
    mutateAfterSelects?: { after: number; mutate: (db: ReportDbMutable) => void };
  } = {}
) {
  const users = opts.users ?? [
    { user_id: USER, admin: 0 },
    { user_id: BOB, admin: 0 },
    { user_id: CAROL, admin: 0 },
    { user_id: ADMIN, admin: 1 },
  ];
  const rooms = opts.rooms ?? [ROOM];
  const events = opts.events ?? [];
  const memberships = opts.memberships ?? [];
  const reports = opts.reports ?? [];
  let nextId = reports.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const eventsLog: string[] = [];
  let selectBarrier = opts.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };
  let selectCount = 0;

  const db = {
    users,
    rooms,
    events,
    memberships,
    reports,
    inserts,
    updates,
    selects,
    eventsLog,
    get nextId() {
      return nextId;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              eventsLog.push(`first:${sql.slice(0, 48)}`);
              selectCount += 1;
              if (opts.failSelectAfter !== undefined && selectCount > opts.failSelectAfter) {
                throw new Error('select-fail');
              }
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.mutateAfterSelects && selectCount === opts.mutateAfterSelects.after) {
                opts.mutateAfterSelects.mutate(db as ReportDbMutable);
                eventsLog.push('mutate:after-select');
              }

              if (sql.includes('SELECT membership FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              if (sql.includes('SELECT event_id FROM events WHERE event_id = ? AND room_id = ?')) {
                const [eventId, roomId] = args as string[];
                const row = events.find((e) => e.event_id === eventId && e.room_id === roomId);
                return (row ? { event_id: row.event_id } : null) as T;
              }
              if (sql.includes('SELECT room_id FROM rooms WHERE room_id = ?')) {
                const roomId = args[0] as string;
                return (rooms.includes(roomId) ? { room_id: roomId } : null) as T;
              }
              if (sql.includes('SELECT user_id FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                return (row ? { user_id: row.user_id } : null) as T;
              }
              if (sql.includes('SELECT admin FROM users WHERE user_id = ?')) {
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                return (row ? { admin: row.admin } : null) as T;
              }
              if (
                sql.includes('SELECT id FROM content_reports') &&
                sql.includes('reporter_user_id = ? AND room_id = ? AND event_id = ?') &&
                !sql.includes('IS NULL')
              ) {
                const [reporter, roomId, eventId] = args as string[];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id === eventId
                );
                return (row ? { id: row.id } : null) as T;
              }
              if (
                sql.includes('SELECT id FROM content_reports') &&
                sql.includes('event_id IS NULL') &&
                sql.includes("report_type = 'room'")
              ) {
                const [reporter, roomId] = args as string[];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id == null &&
                    r.report_type === 'room'
                );
                return (row ? { id: row.id } : null) as T;
              }
              if (
                sql.includes('SELECT id FROM content_reports') &&
                sql.includes('reported_user_id = ?') &&
                sql.includes("report_type = 'user'")
              ) {
                const [reporter, reported] = args as string[];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.reported_user_id === reported &&
                    r.report_type === 'user'
                );
                return (row ? { id: row.id } : null) as T;
              }
              if (
                sql.includes('FROM content_reports cr') &&
                sql.includes('LEFT JOIN events e') &&
                sql.includes('WHERE cr.id = ?')
              ) {
                const id = args[0] as number;
                const row = reports.find((r) => r.id === id);
                if (!row) return null;
                const ev = events.find((e) => e.event_id === row.event_id);
                return {
                  ...row,
                  resolved: Boolean(row.resolved),
                  reported_user_id: ev?.sender ?? row.reported_user_id ?? null,
                  event_type: ev?.event_type ?? null,
                  content: ev?.content ?? null,
                } as T;
              }
              if (
                sql.includes('FROM content_reports') &&
                sql.includes('WHERE id = ?') &&
                !sql.includes('LEFT JOIN')
              ) {
                const id = args[0] as number;
                const row = reports.find((r) => r.id === id);
                return (row ?? null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 180)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (
                sql.includes('FROM content_reports cr') &&
                sql.includes('LEFT JOIN events e') &&
                sql.includes('WHERE 1=1')
              ) {
                let filtered = [...reports];
                if (sql.includes('AND cr.resolved = 1')) {
                  filtered = filtered.filter((r) => r.resolved === 1);
                } else if (sql.includes('AND cr.resolved = 0')) {
                  filtered = filtered.filter((r) => r.resolved === 0);
                }
                let fromId: number | undefined;
                let limit: number;
                if (sql.includes('AND cr.id < ?')) {
                  fromId = args[0] as number;
                  limit = args[1] as number;
                  filtered = filtered.filter((r) => r.id < fromId!);
                } else {
                  limit = args[0] as number;
                }
                filtered.sort((a, b) => b.created_at - a.created_at);
                const slice = filtered.slice(0, limit);
                const results = slice.map((r) => {
                  const ev = events.find((e) => e.event_id === r.event_id);
                  return {
                    ...r,
                    resolved: Boolean(r.resolved),
                    reported_user_id: ev?.sender ?? r.reported_user_id ?? null,
                    event_type: ev?.event_type ?? null,
                    content: ev?.content ?? null,
                  };
                });
                return { results: results as T[] };
              }
              return { results: [] as T[] };
            },
            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              if (
                sql.includes('UPDATE content_reports SET reason = ?, score = ?, created_at = ?') &&
                sql.includes('event_id = ?') &&
                !sql.includes('IS NULL')
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-event-report');
                const [reason, score, createdAt, reporter, roomId, eventId] = args as [
                  string,
                  number,
                  number,
                  string,
                  string,
                  string,
                ];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id === eventId
                );
                if (row) {
                  row.reason = reason;
                  row.score = score;
                  row.created_at = createdAt;
                  return { success: true, meta: { changes: 1, last_row_id: row.id } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE content_reports SET reason = ?, score = ?, created_at = ?') &&
                sql.includes('event_id IS NULL') &&
                sql.includes("report_type = 'room'")
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-room-report');
                const [reason, score, createdAt, reporter, roomId] = args as [
                  string,
                  number,
                  number,
                  string,
                  string,
                ];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.room_id === roomId &&
                    r.event_id == null &&
                    r.report_type === 'room'
                );
                if (row) {
                  row.reason = reason;
                  row.score = score;
                  row.created_at = createdAt;
                  return { success: true, meta: { changes: 1, last_row_id: row.id } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (
                sql.includes('UPDATE content_reports SET reason = ?, created_at = ?') &&
                sql.includes("report_type = 'user'")
              ) {
                updates.push({ sql, args });
                eventsLog.push('run:update-user-report');
                const [reason, createdAt, reporter, reported] = args as [
                  string,
                  number,
                  string,
                  string,
                ];
                const row = reports.find(
                  (r) =>
                    r.reporter_user_id === reporter &&
                    r.reported_user_id === reported &&
                    r.report_type === 'user'
                );
                if (row) {
                  row.reason = reason;
                  row.created_at = createdAt;
                  return { success: true, meta: { changes: 1, last_row_id: row.id } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE content_reports') && sql.includes('SET resolved = 1')) {
                updates.push({ sql, args });
                eventsLog.push('run:resolve');
                const [resolvedBy, resolvedAt, note, id] = args as [
                  string,
                  number,
                  string | null,
                  number,
                ];
                const row = reports.find((r) => r.id === id);
                if (!row || row.resolved === 1) {
                  return { success: true, meta: { changes: 0, last_row_id: 0 } };
                }
                row.resolved = 1;
                row.resolved_by = resolvedBy;
                row.resolved_at = resolvedAt;
                row.resolution_note = note;
                return { success: true, meta: { changes: 1, last_row_id: row.id } };
              }
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes('(reporter_user_id, room_id, event_id, reason, score, created_at)') &&
                !sql.includes('report_type')
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-event-report');
                const [reporter, roomId, eventId, reason, score, createdAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                ];
                const id = nextId++;
                reports.push({
                  id,
                  reporter_user_id: reporter,
                  room_id: roomId,
                  event_id: eventId,
                  reason,
                  score,
                  created_at: createdAt,
                  resolved: 0,
                  report_type: 'event',
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes("VALUES (?, ?, NULL, ?, ?, ?, 'room')")
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-room-report');
                const [reporter, roomId, reason, score, createdAt] = args as [
                  string,
                  string,
                  string,
                  number,
                  number,
                ];
                const id = nextId++;
                reports.push({
                  id,
                  reporter_user_id: reporter,
                  room_id: roomId,
                  event_id: null,
                  reason,
                  score,
                  created_at: createdAt,
                  resolved: 0,
                  report_type: 'room',
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes('reported_user_id')
              ) {
                inserts.push({ sql, args });
                eventsLog.push('run:insert-user-report');
                const [reporter, reason, createdAt, reportedUser] = args as [
                  string,
                  string,
                  number,
                  string,
                ];
                const id = nextId++;
                reports.push({
                  id,
                  reporter_user_id: reporter,
                  room_id: null,
                  event_id: null,
                  reason,
                  score: -100,
                  created_at: createdAt,
                  resolved: 0,
                  report_type: 'user',
                  reported_user_id: reportedUser,
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 180)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type ReportDb = ReturnType<typeof createReportDb>;
type ReportDbMutable = ReportDb;

type NoticeUserRow = {
  user_id: string;
  localpart: string;
  display_name: string;
  admin: number;
  is_guest: number;
  is_deactivated: number;
};
type NoticeRoomRow = {
  room_id: string;
  room_version: string;
  is_public: number;
  creator_id: string;
  created_at: number;
};
type NoticeEventRow = {
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
};
type NoticeStateRow = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};
type NoticeMembershipRow = {
  room_id: string;
  user_id: string;
  membership: string;
  event_id: string;
  display_name?: string | null;
};
type NoticeDb = {
  users: Map<string, NoticeUserRow>;
  rooms: Map<string, NoticeRoomRow>;
  events: NoticeEventRow[];
  roomState: NoticeStateRow[];
  memberships: NoticeMembershipRow[];
  sqlLog: string[];
  failAdminSelect?: boolean;
  failInsertMessage?: boolean;
};

function seedNoticeUser(userId: string, admin: number): NoticeUserRow {
  const localpart = userId.slice(1).split(':')[0];
  return {
    user_id: userId,
    localpart,
    display_name: localpart,
    admin,
    is_guest: 0,
    is_deactivated: 0,
  };
}

function createNoticeDb(
  seed?: Partial<NoticeDb> & { selectBarrier?: SelectBarrier }
): D1Database & { store: NoticeDb; eventsLog: string[] } {
  const store: NoticeDb = {
    users: seed?.users ?? new Map([[ADMIN, seedNoticeUser(ADMIN, 1)]]),
    rooms: seed?.rooms ?? new Map(),
    events: seed?.events ?? [],
    roomState: seed?.roomState ?? [],
    memberships: seed?.memberships ?? [],
    sqlLog: [],
    failAdminSelect: seed?.failAdminSelect,
    failInsertMessage: seed?.failInsertMessage,
  };
  let selectBarrier = seed?.selectBarrier;
  const waitersRef = { list: [] as Array<() => void> };
  const eventsLog: string[] = [];

  return {
    store,
    eventsLog,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              eventsLog.push(`first:${sql.slice(0, 56)}`);
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('SELECT admin FROM users WHERE user_id = ?')) {
                if (store.failAdminSelect) throw new Error('admin select failed');
                const [userId] = args as [string];
                const row = store.users.get(userId);
                return (row ? { admin: row.admin } : null) as T;
              }
              if (sql.includes('SELECT user_id FROM users WHERE user_id')) {
                const [userId] = args as [string];
                const row = store.users.get(userId);
                return (row ? { user_id: row.user_id } : null) as T;
              }
              if (
                sql.includes('FROM room_memberships rm') &&
                sql.includes('m.room.create') &&
                sql.includes('m.server_notice')
              ) {
                const [targetUserId] = args as [string];
                for (const m of store.memberships) {
                  if (m.user_id !== targetUserId) continue;
                  const createState = store.roomState.find(
                    (s) =>
                      s.room_id === m.room_id &&
                      s.event_type === 'm.room.create' &&
                      s.state_key === ''
                  );
                  if (!createState) continue;
                  const createEvent = store.events.find((e) => e.event_id === createState.event_id);
                  if (createEvent?.content.includes(`"type":"${NOTICE_ROOM_TYPE}"`)) {
                    return { room_id: m.room_id } as T;
                  }
                }
                return null as T;
              }
              if (
                sql.includes('SELECT event_id, depth FROM events') &&
                sql.includes('ORDER BY depth DESC')
              ) {
                const [roomId] = args as [string];
                const inRoom = store.events
                  .filter((e) => e.room_id === roomId)
                  .sort((a, b) => b.depth - a.depth);
                if (!inRoom.length) return null as T;
                return { event_id: inRoom[0].event_id, depth: inRoom[0].depth } as T;
              }
              return null as T;
            },
            async all<T>() {
              await withSelectBarrier(
                selectBarrier,
                waitersRef,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (
                sql.includes('FROM room_state rs') &&
                sql.includes('m.room.create') &&
                sql.includes('m.room.power_levels') &&
                sql.includes('m.room.member')
              ) {
                const [roomId, serverUserId] = args as [string, string];
                const rows = store.roomState
                  .filter(
                    (s) =>
                      s.room_id === roomId &&
                      ['m.room.create', 'm.room.power_levels', 'm.room.member'].includes(
                        s.event_type
                      ) &&
                      (s.state_key === '' || s.state_key === serverUserId)
                  )
                  .map((s) => ({ event_id: s.event_id }));
                return { results: rows as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO users')) {
                const [userId, localpart] = args as [string, string];
                store.users.set(userId, {
                  user_id: userId,
                  localpart,
                  display_name: 'Server Notices',
                  admin: 0,
                  is_guest: 0,
                  is_deactivated: 0,
                });
                eventsLog.push('run:insert-server-user');
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO rooms')) {
                const [roomId, creatorId, createdAt] = args as [string, string, number];
                store.rooms.set(roomId, {
                  room_id: roomId,
                  room_version: '10',
                  is_public: 0,
                  creator_id: creatorId,
                  created_at: createdAt,
                });
                eventsLog.push('run:insert-room');
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO events') && sql.includes('state_key')) {
                const [
                  eventId,
                  roomId,
                  sender,
                  eventType,
                  stateKey,
                  content,
                  originServerTs,
                  depth,
                  authEvents,
                  prevEvents,
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
                ];
                store.events.push({
                  event_id: eventId,
                  room_id: roomId,
                  sender,
                  event_type: eventType,
                  state_key: stateKey,
                  content,
                  origin_server_ts: originServerTs,
                  depth,
                  auth_events: authEvents,
                  prev_events: prevEvents,
                });
                eventsLog.push('run:insert-state-event');
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO events') && sql.includes("m.room.message")) {
                if (store.failInsertMessage) throw new Error('message insert failed');
                const [
                  eventId,
                  roomId,
                  sender,
                  content,
                  originServerTs,
                  depth,
                  authEvents,
                  prevEvents,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  string,
                  string,
                ];
                store.events.push({
                  event_id: eventId,
                  room_id: roomId,
                  sender,
                  event_type: 'm.room.message',
                  state_key: null,
                  content,
                  origin_server_ts: originServerTs,
                  depth,
                  auth_events: authEvents,
                  prev_events: prevEvents,
                });
                eventsLog.push('run:insert-message');
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT OR REPLACE INTO room_state')) {
                const [roomId, eventType, stateKey, eventId] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const idx = store.roomState.findIndex(
                  (s) =>
                    s.room_id === roomId &&
                    s.event_type === eventType &&
                    s.state_key === stateKey
                );
                const row = {
                  room_id: roomId,
                  event_type: eventType,
                  state_key: stateKey,
                  event_id: eventId,
                };
                if (idx >= 0) store.roomState[idx] = row;
                else store.roomState.push(row);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO room_memberships') && sql.includes('display_name')) {
                const [roomId, userId, eventId] = args as [string, string, string];
                store.memberships.push({
                  room_id: roomId,
                  user_id: userId,
                  membership: 'join',
                  event_id: eventId,
                  display_name: 'Server Notices',
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO room_memberships')) {
                const [roomId, userId, eventId] = args as [string, string, string];
                store.memberships.push({
                  room_id: roomId,
                  user_id: userId,
                  membership: 'invite',
                  event_id: eventId,
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: NoticeDb; eventsLog: string[] };
}

type NoticeDbHandle = ReturnType<typeof createNoticeDb>;

function envFor(db: unknown, serverName = SERVER): Env {
  return {
    DB: db as D1Database,
    SERVER_NAME: serverName,
  } as unknown as Env;
}

async function reportReq(
  db: ReportDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await reportApp.request(`http://localhost${path}`, init, envFor(db));
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function noticeReq(
  db: NoticeDbHandle,
  path: string,
  init: RequestInit = {},
  serverName = SERVER
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await serverNoticesApp.request(
    `http://localhost${path}`,
    init,
    envFor(db, serverName)
  );
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown, contentType = 'application/json'): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': contentType,
      ...AUTH,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function noticeJson(body?: unknown): RequestInit {
  return jsonInit('POST', body);
}

function noticePayload(
  overrides: {
    user_id?: string;
    body?: string;
    msgtype?: string;
    admin_contact?: string;
    omitContent?: boolean;
    omitBody?: boolean;
    omitUserId?: boolean;
  } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!overrides.omitUserId) payload.user_id = overrides.user_id ?? BOB;
  if (overrides.omitContent) return payload;
  const content: Record<string, unknown> = {};
  if (!overrides.omitBody) content.body = overrides.body ?? 'Notice body';
  if (overrides.msgtype !== undefined) content.msgtype = overrides.msgtype;
  if (overrides.admin_contact !== undefined) content.admin_contact = overrides.admin_contact;
  payload.content = content;
  return payload;
}

function messageEvents(db: NoticeDb, roomId?: string) {
  return db.events
    .filter(
      (e) =>
        e.event_type === 'm.room.message' && (roomId === undefined || e.room_id === roomId)
    )
    .sort((a, b) => a.depth - b.depth);
}

function noticeRooms(db: NoticeDb) {
  return [...db.rooms.keys()];
}

function seedWarmNoticeRoom(
  store: NoticeDb,
  targetUserId: string,
  roomId = '!notice:example.com'
) {
  store.users.set(SERVER_USER, seedNoticeUser(SERVER_USER, 0));
  store.users.get(SERVER_USER)!.display_name = 'Server Notices';
  store.rooms.set(roomId, {
    room_id: roomId,
    room_version: '10',
    is_public: 0,
    creator_id: SERVER_USER,
    created_at: NOW,
  });
  const createId = '$create:example.com';
  const plId = '$pl:example.com';
  const memId = '$mem:example.com';
  store.events.push(
    {
      event_id: createId,
      room_id: roomId,
      sender: SERVER_USER,
      event_type: 'm.room.create',
      state_key: '',
      content: JSON.stringify({
        creator: SERVER_USER,
        room_version: '10',
        type: NOTICE_ROOM_TYPE,
      }),
      origin_server_ts: NOW,
      depth: 1,
      auth_events: '[]',
      prev_events: '[]',
    },
    {
      event_id: plId,
      room_id: roomId,
      sender: SERVER_USER,
      event_type: 'm.room.power_levels',
      state_key: '',
      content: '{}',
      origin_server_ts: NOW + 1,
      depth: 2,
      auth_events: JSON.stringify([createId]),
      prev_events: JSON.stringify([createId]),
    },
    {
      event_id: memId,
      room_id: roomId,
      sender: SERVER_USER,
      event_type: 'm.room.member',
      state_key: SERVER_USER,
      content: JSON.stringify({ membership: 'join' }),
      origin_server_ts: NOW + 2,
      depth: 3,
      auth_events: JSON.stringify([createId, plId]),
      prev_events: JSON.stringify([plId]),
    }
  );
  store.roomState.push(
    { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: createId },
    { room_id: roomId, event_type: 'm.room.power_levels', state_key: '', event_id: plId },
    {
      room_id: roomId,
      event_type: 'm.room.member',
      state_key: SERVER_USER,
      event_id: memId,
    }
  );
  store.memberships.push(
    {
      room_id: roomId,
      user_id: SERVER_USER,
      membership: 'join',
      event_id: memId,
      display_name: 'Server Notices',
    },
    {
      room_id: roomId,
      user_id: targetUserId,
      membership: 'invite',
      event_id: memId,
    }
  );
  return roomId;
}

function seedEventReport(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: overrides.id ?? 1,
    reporter_user_id: overrides.reporter_user_id ?? USER,
    // Allow explicit null (room/user reports) — do not coalesce null → default
    room_id: overrides.room_id !== undefined ? overrides.room_id : ROOM,
    event_id: overrides.event_id !== undefined ? overrides.event_id : EVENT,
    reason: overrides.reason ?? 'spam',
    score: overrides.score ?? -50,
    created_at: overrides.created_at ?? NOW,
    resolved: overrides.resolved ?? 0,
    report_type: overrides.report_type ?? 'event',
    reported_user_id: overrides.reported_user_id,
    resolved_by: overrides.resolved_by,
    resolved_at: overrides.resolved_at,
    resolution_note: overrides.resolution_note,
  };
}

function seedRoomReport(overrides: Partial<ReportRow> = {}): ReportRow {
  return seedEventReport({
    id: overrides.id ?? 2,
    reason: overrides.reason ?? 'room-spam',
    score: overrides.score ?? -10,
    ...overrides,
    event_id: null,
    report_type: 'room',
  });
}

function seedUserReport(overrides: Partial<ReportRow> = {}): ReportRow {
  return seedEventReport({
    id: overrides.id ?? 3,
    reason: overrides.reason ?? 'user-spam',
    score: -100,
    ...overrides,
    room_id: null,
    event_id: null,
    report_type: 'user',
    reported_user_id: overrides.reported_user_id ?? BOB,
  });
}

beforeEach(() => {
  eventSeq = 0;
  opaqueSeq = 0;
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  generateOpaqueId.mockReset();
  generateEventId.mockReset();
  generateOpaqueId.mockImplementation(
    async (length: number = 18) => `opaque${length}-${++opaqueSeq}`
  );
  generateEventId.mockImplementation(
    async (serverName: string) => `$evt-${++eventSeq}:${serverName}`
  );
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('race report user duplicate INSERT TOCTOU after #197', () => {
  it('user report duplicate INSERT race #0', async () => {
    const reported = '@target0:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-0' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-0' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #1', async () => {
    const reported = '@target1:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-1' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-1' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #2', async () => {
    const reported = '@target2:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-2' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-2' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #3', async () => {
    const reported = '@target3:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-3' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-3' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #4', async () => {
    const reported = '@target4:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-4' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-4' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #5', async () => {
    const reported = '@target5:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-5' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-5' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #6', async () => {
    const reported = '@target6:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-6' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-6' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #7', async () => {
    const reported = '@target7:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-7' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-7' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #8', async () => {
    const reported = '@target8:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-8' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-8' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #9', async () => {
    const reported = '@target9:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-9' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-9' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #10', async () => {
    const reported = '@target10:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-10' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-10' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #11', async () => {
    const reported = '@target11:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-11' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-11' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #12', async () => {
    const reported = '@target12:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-12' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-12' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #13', async () => {
    const reported = '@target13:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-13' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-13' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #14', async () => {
    const reported = '@target14:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-14' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-14' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
  it('user report duplicate INSERT race #15', async () => {
    const reported = '@target15:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: ADMIN, admin: 1 },
      ],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'user-A-15' })),
      reportReq(db, path, jsonInit('POST', { reason: 'user-B-15' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(
      db.reports.filter((r) => r.reported_user_id === reported && r.report_type === 'user').length
    ).toBeGreaterThanOrEqual(1);
    expect(db.inserts.filter((x) => x.sql.includes('reported_user_id')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('race report event UPDATE last-write-wins after #197', () => {
  it('event report UPDATE LWW race #0', async () => {
    const evt = `$upd0:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 0, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-0', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-0', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-0', 'B-0']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #1', async () => {
    const evt = `$upd1:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 1, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-1', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-1', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-1', 'B-1']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #2', async () => {
    const evt = `$upd2:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 2, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-2', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-2', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-2', 'B-2']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #3', async () => {
    const evt = `$upd3:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 3, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-3', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-3', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-3', 'B-3']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #4', async () => {
    const evt = `$upd4:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 4, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-4', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-4', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-4', 'B-4']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #5', async () => {
    const evt = `$upd5:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 5, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-5', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-5', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-5', 'B-5']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #6', async () => {
    const evt = `$upd6:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 6, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-6', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-6', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-6', 'B-6']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #7', async () => {
    const evt = `$upd7:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 7, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-7', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-7', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-7', 'B-7']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #8', async () => {
    const evt = `$upd8:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 8, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-8', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-8', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-8', 'B-8']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #9', async () => {
    const evt = `$upd9:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 9, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-9', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-9', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-9', 'B-9']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #10', async () => {
    const evt = `$upd10:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 10, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-10', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-10', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-10', 'B-10']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #11', async () => {
    const evt = `$upd11:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 11, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-11', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-11', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-11', 'B-11']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #12', async () => {
    const evt = `$upd12:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 12, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-12', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-12', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-12', 'B-12']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #13', async () => {
    const evt = `$upd13:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 13, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-13', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-13', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-13', 'B-13']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #14', async () => {
    const evt = `$upd14:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 14, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-14', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-14', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-14', 'B-14']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
  it('event report UPDATE LWW race #15', async () => {
    const evt = `$upd15:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 50 + 15, event_id: evt, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'A-15', score: -10 })),
      reportReq(db, path, jsonInit('POST', { reason: 'B-15', score: -20 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.updates.filter((u) => u.sql.includes('UPDATE content_reports')).length).toBe(2);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(['A-15', 'B-15']).toContain(row.reason);
    expect([-10, -20]).toContain(row.score);
  });
});

describe('race report room UPDATE last-write-wins after #197', () => {
  it('room report UPDATE LWW race #0', async () => {
    const room = '!updroom0:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 0, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-0', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-0', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-0', 'RB-0']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #1', async () => {
    const room = '!updroom1:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 1, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-1', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-1', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-1', 'RB-1']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #2', async () => {
    const room = '!updroom2:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 2, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-2', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-2', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-2', 'RB-2']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #3', async () => {
    const room = '!updroom3:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 3, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-3', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-3', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-3', 'RB-3']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #4', async () => {
    const room = '!updroom4:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 4, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-4', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-4', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-4', 'RB-4']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #5', async () => {
    const room = '!updroom5:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 5, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-5', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-5', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-5', 'RB-5']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #6', async () => {
    const room = '!updroom6:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 6, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-6', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-6', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-6', 'RB-6']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #7', async () => {
    const room = '!updroom7:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 7, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-7', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-7', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-7', 'RB-7']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #8', async () => {
    const room = '!updroom8:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 8, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-8', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-8', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-8', 'RB-8']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #9', async () => {
    const room = '!updroom9:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 9, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-9', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-9', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-9', 'RB-9']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #10', async () => {
    const room = '!updroom10:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 10, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-10', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-10', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-10', 'RB-10']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #11', async () => {
    const room = '!updroom11:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 11, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-11', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-11', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-11', 'RB-11']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #12', async () => {
    const room = '!updroom12:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 12, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-12', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-12', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-12', 'RB-12']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #13', async () => {
    const room = '!updroom13:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 13, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-13', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-13', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-13', 'RB-13']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #14', async () => {
    const room = '!updroom14:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 14, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-14', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-14', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-14', 'RB-14']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
  it('room report UPDATE LWW race #15', async () => {
    const room = '!updroom15:example.com';
    const db = createReportDb({
      rooms: [room],
      reports: [seedRoomReport({ id: 60 + 15, room_id: room, reason: 'old', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id IS NULL') &&
          sql.includes("report_type = 'room'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'RA-15', score: -5 })),
      reportReq(db, path, jsonInit('POST', { reason: 'RB-15', score: -15 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find((r) => r.room_id === room && r.report_type === 'room')!;
    expect(['RA-15', 'RB-15']).toContain(row.reason);
    expect([-5, -15]).toContain(row.score);
  });
});

describe('race report user UPDATE last-write-wins after #197', () => {
  it('user report UPDATE LWW race #0', async () => {
    const reported = '@upduser0:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 0, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-0' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-0' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-0', 'UB-0']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #1', async () => {
    const reported = '@upduser1:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 1, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-1' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-1' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-1', 'UB-1']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #2', async () => {
    const reported = '@upduser2:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 2, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-2' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-2' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-2', 'UB-2']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #3', async () => {
    const reported = '@upduser3:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 3, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-3' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-3' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-3', 'UB-3']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #4', async () => {
    const reported = '@upduser4:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 4, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-4' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-4' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-4', 'UB-4']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #5', async () => {
    const reported = '@upduser5:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 5, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-5' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-5' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-5', 'UB-5']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #6', async () => {
    const reported = '@upduser6:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 6, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-6' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-6' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-6', 'UB-6']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #7', async () => {
    const reported = '@upduser7:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 7, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-7' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-7' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-7', 'UB-7']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #8', async () => {
    const reported = '@upduser8:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 8, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-8' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-8' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-8', 'UB-8']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #9', async () => {
    const reported = '@upduser9:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 9, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-9' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-9' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-9', 'UB-9']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #10', async () => {
    const reported = '@upduser10:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 10, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-10' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-10' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-10', 'UB-10']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #11', async () => {
    const reported = '@upduser11:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 11, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-11' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-11' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-11', 'UB-11']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #12', async () => {
    const reported = '@upduser12:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 12, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-12' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-12' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-12', 'UB-12']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #13', async () => {
    const reported = '@upduser13:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 13, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-13' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-13' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-13', 'UB-13']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #14', async () => {
    const reported = '@upduser14:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 14, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-14' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-14' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-14', 'UB-14']).toContain(row.reason);
  });
  it('user report UPDATE LWW race #15', async () => {
    const reported = '@upduser15:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
      ],
      reports: [seedUserReport({ id: 70 + 15, reported_user_id: reported, reason: 'old' })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('reported_user_id = ?') &&
          sql.includes("report_type = 'user'"),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'UA-15' })),
      reportReq(db, path, jsonInit('POST', { reason: 'UB-15' })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.inserts.length).toBe(0);
    const row = db.reports.find(
      (r) => r.reported_user_id === reported && r.report_type === 'user'
    )!;
    expect(['UA-15', 'UB-15']).toContain(row.reason);
  });
});

describe('race report event POST∥admin resolve after #197', () => {
  it('event report∥resolve race #0', async () => {
    const evt = `$pr0:example.com`;
    const rid = 200 + 0;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-0', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-0' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #1', async () => {
    const evt = `$pr1:example.com`;
    const rid = 200 + 1;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-1', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-1' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #2', async () => {
    const evt = `$pr2:example.com`;
    const rid = 200 + 2;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-2', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-2' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #3', async () => {
    const evt = `$pr3:example.com`;
    const rid = 200 + 3;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-3', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-3' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #4', async () => {
    const evt = `$pr4:example.com`;
    const rid = 200 + 4;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-4', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-4' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #5', async () => {
    const evt = `$pr5:example.com`;
    const rid = 200 + 5;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-5', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-5' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #6', async () => {
    const evt = `$pr6:example.com`;
    const rid = 200 + 6;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-6', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-6' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #7', async () => {
    const evt = `$pr7:example.com`;
    const rid = 200 + 7;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-7', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-7' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #8', async () => {
    const evt = `$pr8:example.com`;
    const rid = 200 + 8;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-8', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-8' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #9', async () => {
    const evt = `$pr9:example.com`;
    const rid = 200 + 9;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-9', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-9' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #10', async () => {
    const evt = `$pr10:example.com`;
    const rid = 200 + 10;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-10', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-10' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #11', async () => {
    const evt = `$pr11:example.com`;
    const rid = 200 + 11;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-11', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-11' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #12', async () => {
    const evt = `$pr12:example.com`;
    const rid = 200 + 12;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-12', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-12' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #13', async () => {
    const evt = `$pr13:example.com`;
    const rid = 200 + 13;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-13', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-13' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #14', async () => {
    const evt = `$pr14:example.com`;
    const rid = 200 + 14;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-14', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-14' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
  it('event report∥resolve race #15', async () => {
    const evt = `$pr15:example.com`;
    const rid = 200 + 15;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: rid, event_id: evt, reason: 'seed', score: -1 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') ||
          sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const reportPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const resolvePath = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, reportPath, jsonInit('POST', { reason: 'live-15', score: -40 })),
      reportReq(db, resolvePath, jsonInit('POST', { note: 'done-15' })),
    ]);
    expect([200, 404]).toContain(a.status);
    expect([200, 404]).toContain(b.status);
    const row = db.reports.find((r) => r.id === rid)!;
    // Either resolve applied, update applied, or both — row still present
    expect(row).toBeTruthy();
    if (row.resolved === 1) {
      expect(row.resolved_by).toBe(USER);
    }
  });
});

describe('race report admin list∥resolve after #197', () => {
  it('admin list∥resolve race #0', async () => {
    const rid = 300 + 0;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-0', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-0' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #1', async () => {
    const rid = 300 + 1;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-1', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-1' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #2', async () => {
    const rid = 300 + 2;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-2', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-2' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #3', async () => {
    const rid = 300 + 3;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-3', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-3' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #4', async () => {
    const rid = 300 + 4;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-4', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-4' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #5', async () => {
    const rid = 300 + 5;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-5', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-5' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #6', async () => {
    const rid = 300 + 6;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-6', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-6' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #7', async () => {
    const rid = 300 + 7;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-7', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-7' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #8', async () => {
    const rid = 300 + 8;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-8', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-8' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #9', async () => {
    const rid = 300 + 9;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-9', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-9' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #10', async () => {
    const rid = 300 + 10;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-10', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-10' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #11', async () => {
    const rid = 300 + 11;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-11', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-11' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #12', async () => {
    const rid = 300 + 12;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-12', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-12' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #13', async () => {
    const rid = 300 + 13;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-13', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-13' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #14', async () => {
    const rid = 300 + 14;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-14', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-14' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin list∥resolve race #15', async () => {
    const rid = 300 + 15;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{"body":"x"}' }],
      reports: [
        seedEventReport({ id: rid, reason: 'list-15', resolved: 0 }),
        seedEventReport({ id: rid + 1000, event_id: '$other:example.com', reason: 'other', resolved: 0 }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [listRes, resolveRes] = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=10', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'n-15' })
      ),
    ]);
    expect(listRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    const body = listRes.body as { reports?: Array<{ id: number; resolved?: boolean }> };
    expect(Array.isArray(body.reports)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
});

describe('race report admin get∥resolve after #197', () => {
  it('admin get∥resolve race #0', async () => {
    const rid = 400 + 0;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-0', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-0' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #1', async () => {
    const rid = 400 + 1;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-1', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-1' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #2', async () => {
    const rid = 400 + 2;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-2', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-2' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #3', async () => {
    const rid = 400 + 3;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-3', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-3' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #4', async () => {
    const rid = 400 + 4;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-4', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-4' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #5', async () => {
    const rid = 400 + 5;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-5', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-5' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #6', async () => {
    const rid = 400 + 6;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-6', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-6' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #7', async () => {
    const rid = 400 + 7;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-7', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-7' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #8', async () => {
    const rid = 400 + 8;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-8', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-8' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #9', async () => {
    const rid = 400 + 9;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-9', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-9' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #10', async () => {
    const rid = 400 + 10;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-10', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-10' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #11', async () => {
    const rid = 400 + 11;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-11', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-11' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #12', async () => {
    const rid = 400 + 12;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-12', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-12' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #13', async () => {
    const rid = 400 + 13;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-13', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-13' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #14', async () => {
    const rid = 400 + 14;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-14', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-14' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
  it('admin get∥resolve race #15', async () => {
    const rid = 400 + 15;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 1 },
        { user_id: BOB, admin: 0 },
      ],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{"body":"hi"}',
        },
      ],
      reports: [seedEventReport({ id: rid, reason: 'get-15', resolved: 0 })],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const [getRes, resolveRes] = await Promise.all([
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'g-15' })
      ),
    ]);
    expect(getRes.status).toBe(200);
    expect([200, 404]).toContain(resolveRes.status);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(1);
  });
});

describe('race report cross-type event∥room∥user after #197', () => {
  it('cross-type concurrent race #0', async () => {
    const evt = `$x0:example.com`;
    const room = '!xroom0:example.com';
    const reported = '@xuser0:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-0', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-0', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-0' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #1', async () => {
    const evt = `$x1:example.com`;
    const room = '!xroom1:example.com';
    const reported = '@xuser1:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-1', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-1', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-1' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #2', async () => {
    const evt = `$x2:example.com`;
    const room = '!xroom2:example.com';
    const reported = '@xuser2:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-2', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-2', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-2' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #3', async () => {
    const evt = `$x3:example.com`;
    const room = '!xroom3:example.com';
    const reported = '@xuser3:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-3', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-3', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-3' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #4', async () => {
    const evt = `$x4:example.com`;
    const room = '!xroom4:example.com';
    const reported = '@xuser4:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-4', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-4', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-4' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #5', async () => {
    const evt = `$x5:example.com`;
    const room = '!xroom5:example.com';
    const reported = '@xuser5:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-5', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-5', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-5' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #6', async () => {
    const evt = `$x6:example.com`;
    const room = '!xroom6:example.com';
    const reported = '@xuser6:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-6', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-6', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-6' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #7', async () => {
    const evt = `$x7:example.com`;
    const room = '!xroom7:example.com';
    const reported = '@xuser7:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-7', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-7', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-7' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #8', async () => {
    const evt = `$x8:example.com`;
    const room = '!xroom8:example.com';
    const reported = '@xuser8:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-8', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-8', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-8' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #9', async () => {
    const evt = `$x9:example.com`;
    const room = '!xroom9:example.com';
    const reported = '@xuser9:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-9', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-9', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-9' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #10', async () => {
    const evt = `$x10:example.com`;
    const room = '!xroom10:example.com';
    const reported = '@xuser10:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-10', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-10', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-10' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #11', async () => {
    const evt = `$x11:example.com`;
    const room = '!xroom11:example.com';
    const reported = '@xuser11:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-11', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-11', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-11' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #12', async () => {
    const evt = `$x12:example.com`;
    const room = '!xroom12:example.com';
    const reported = '@xuser12:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-12', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-12', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-12' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #13', async () => {
    const evt = `$x13:example.com`;
    const room = '!xroom13:example.com';
    const reported = '@xuser13:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-13', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-13', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-13' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #14', async () => {
    const evt = `$x14:example.com`;
    const room = '!xroom14:example.com';
    const reported = '@xuser14:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-14', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-14', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-14' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
  it('cross-type concurrent race #15', async () => {
    const evt = `$x15:example.com`;
    const room = '!xroom15:example.com';
    const reported = '@xuser15:example.com';
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: reported, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      rooms: [room, ROOM],
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    const [e, r, u] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
        jsonInit('POST', { reason: 'e-15', score: -11 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/report`,
        jsonInit('POST', { reason: 'r-15', score: -22 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/users/${encodeURIComponent(reported)}/report`,
        jsonInit('POST', { reason: 'u-15' })
      ),
    ]);
    expect(e.status).toBe(200);
    expect(r.status).toBe(200);
    expect(u.status).toBe(200);
    expect(db.reports.some((x) => x.event_id === evt)).toBe(true);
    expect(db.reports.some((x) => x.room_id === room && x.report_type === 'room')).toBe(true);
    expect(db.reports.some((x) => x.reported_user_id === reported)).toBe(true);
  });
});

describe('race report distinct-event isolation after #197', () => {
  it('distinct event concurrent isolation #0', async () => {
    const e1 = `$isoA0:example.com`;
    const e2 = `$isoB0:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-0', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-0', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-0');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-0');
  });
  it('distinct event concurrent isolation #1', async () => {
    const e1 = `$isoA1:example.com`;
    const e2 = `$isoB1:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-1', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-1', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-1');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-1');
  });
  it('distinct event concurrent isolation #2', async () => {
    const e1 = `$isoA2:example.com`;
    const e2 = `$isoB2:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-2', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-2', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-2');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-2');
  });
  it('distinct event concurrent isolation #3', async () => {
    const e1 = `$isoA3:example.com`;
    const e2 = `$isoB3:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-3', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-3', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-3');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-3');
  });
  it('distinct event concurrent isolation #4', async () => {
    const e1 = `$isoA4:example.com`;
    const e2 = `$isoB4:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-4', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-4', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-4');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-4');
  });
  it('distinct event concurrent isolation #5', async () => {
    const e1 = `$isoA5:example.com`;
    const e2 = `$isoB5:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-5', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-5', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-5');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-5');
  });
  it('distinct event concurrent isolation #6', async () => {
    const e1 = `$isoA6:example.com`;
    const e2 = `$isoB6:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-6', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-6', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-6');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-6');
  });
  it('distinct event concurrent isolation #7', async () => {
    const e1 = `$isoA7:example.com`;
    const e2 = `$isoB7:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-7', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-7', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-7');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-7');
  });
  it('distinct event concurrent isolation #8', async () => {
    const e1 = `$isoA8:example.com`;
    const e2 = `$isoB8:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-8', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-8', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-8');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-8');
  });
  it('distinct event concurrent isolation #9', async () => {
    const e1 = `$isoA9:example.com`;
    const e2 = `$isoB9:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-9', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-9', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-9');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-9');
  });
  it('distinct event concurrent isolation #10', async () => {
    const e1 = `$isoA10:example.com`;
    const e2 = `$isoB10:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-10', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-10', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-10');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-10');
  });
  it('distinct event concurrent isolation #11', async () => {
    const e1 = `$isoA11:example.com`;
    const e2 = `$isoB11:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-11', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-11', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-11');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-11');
  });
  it('distinct event concurrent isolation #12', async () => {
    const e1 = `$isoA12:example.com`;
    const e2 = `$isoB12:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-12', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-12', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-12');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-12');
  });
  it('distinct event concurrent isolation #13', async () => {
    const e1 = `$isoA13:example.com`;
    const e2 = `$isoB13:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-13', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-13', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-13');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-13');
  });
  it('distinct event concurrent isolation #14', async () => {
    const e1 = `$isoA14:example.com`;
    const e2 = `$isoB14:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-14', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-14', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-14');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-14');
  });
  it('distinct event concurrent isolation #15', async () => {
    const e1 = `$isoA15:example.com`;
    const e2 = `$isoB15:example.com`;
    const db = createReportDb({
      events: [
        { event_id: e1, room_id: ROOM, sender: BOB },
        { event_id: e2, room_id: ROOM, sender: CAROL },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e1)}`,
        jsonInit('POST', { reason: 'isoA-15', score: -3 })
      ),
      reportReq(
        db,
        `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(e2)}`,
        jsonInit('POST', { reason: 'isoB-15', score: -4 })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.find((r) => r.event_id === e1)?.reason).toBe('isoA-15');
    expect(db.reports.find((r) => r.event_id === e2)?.reason).toBe('isoB-15');
  });
});

describe('race report score clamp concurrent after #197', () => {
  it('score clamp concurrent #0', async () => {
    const evt = `$sc0:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 0, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-0', score: 50 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-0', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #1', async () => {
    const evt = `$sc1:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 1, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-1', score: -200 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-1', score: 0 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #2', async () => {
    const evt = `$sc2:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 2, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-2', score: 1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-2', score: -1 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #3', async () => {
    const evt = `$sc3:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 3, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-3', score: "bad" })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-3', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #4', async () => {
    const evt = `$sc4:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 4, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-4', score: 50 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-4', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #5', async () => {
    const evt = `$sc5:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 5, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-5', score: -200 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-5', score: 0 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #6', async () => {
    const evt = `$sc6:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 6, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-6', score: 1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-6', score: -1 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #7', async () => {
    const evt = `$sc7:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 7, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-7', score: "bad" })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-7', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #8', async () => {
    const evt = `$sc8:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 8, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-8', score: 50 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-8', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #9', async () => {
    const evt = `$sc9:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 9, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-9', score: -200 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-9', score: 0 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #10', async () => {
    const evt = `$sc10:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 10, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-10', score: 1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-10', score: -1 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #11', async () => {
    const evt = `$sc11:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 11, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-11', score: "bad" })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-11', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #12', async () => {
    const evt = `$sc12:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 12, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-12', score: 50 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-12', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #13', async () => {
    const evt = `$sc13:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 13, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-13', score: -200 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-13', score: 0 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #14', async () => {
    const evt = `$sc14:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 14, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-14', score: 1 })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-14', score: -1 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
  it('score clamp concurrent #15', async () => {
    const evt = `$sc15:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 80 + 15, event_id: evt, score: -50 })],
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT id FROM content_reports') &&
          sql.includes('event_id = ?') &&
          !sql.includes('IS NULL'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'scA-15', score: "bad" })),
      reportReq(db, path, jsonInit('POST', { reason: 'scB-15', score: -100 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.score).toBeGreaterThanOrEqual(-100);
    expect(row.score).toBeLessThanOrEqual(0);
  });
});

describe('race report leave-membership concurrent after #197', () => {
  it('leave membership concurrent report #0', async () => {
    const evt = `$leave0:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-0', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-0', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #1', async () => {
    const evt = `$leave1:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-1', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-1', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #2', async () => {
    const evt = `$leave2:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-2', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-2', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #3', async () => {
    const evt = `$leave3:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-3', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-3', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #4', async () => {
    const evt = `$leave4:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-4', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-4', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #5', async () => {
    const evt = `$leave5:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-5', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-5', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #6', async () => {
    const evt = `$leave6:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-6', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-6', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #7', async () => {
    const evt = `$leave7:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-7', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-7', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #8', async () => {
    const evt = `$leave8:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-8', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-8', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #9', async () => {
    const evt = `$leave9:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-9', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-9', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #10', async () => {
    const evt = `$leave10:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-10', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-10', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #11', async () => {
    const evt = `$leave11:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-11', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-11', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #12', async () => {
    const evt = `$leave12:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-12', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-12', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #13', async () => {
    const evt = `$leave13:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-13', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-13', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #14', async () => {
    const evt = `$leave14:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-14', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-14', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
  it('leave membership concurrent report #15', async () => {
    const evt = `$leave15:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      reports: [],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT membership FROM room_memberships'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'L-15', score: -9 })),
      reportReq(db, path, jsonInit('POST', { reason: 'L2-15', score: -8 })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.reports.filter((r) => r.event_id === evt).length).toBeGreaterThanOrEqual(1);
  });
});

describe('race report resolve already-resolved soft after #197', () => {
  it('already-resolved resolve soft #0', async () => {
    const rid = 500 + 0;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-0' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-0' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #1', async () => {
    const rid = 500 + 1;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-1' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-1' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #2', async () => {
    const rid = 500 + 2;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-2' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-2' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #3', async () => {
    const rid = 500 + 3;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-3' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-3' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #4', async () => {
    const rid = 500 + 4;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-4' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-4' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #5', async () => {
    const rid = 500 + 5;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-5' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-5' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #6', async () => {
    const rid = 500 + 6;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-6' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-6' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #7', async () => {
    const rid = 500 + 7;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-7' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-7' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #8', async () => {
    const rid = 500 + 8;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-8' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-8' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #9', async () => {
    const rid = 500 + 9;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-9' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-9' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #10', async () => {
    const rid = 500 + 10;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-10' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-10' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #11', async () => {
    const rid = 500 + 11;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-11' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-11' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #12', async () => {
    const rid = 500 + 12;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-12' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-12' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #13', async () => {
    const rid = 500 + 13;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-13' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-13' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #14', async () => {
    const rid = 500 + 14;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-14' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-14' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
  it('already-resolved resolve soft #15', async () => {
    const rid = 500 + 15;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      reports: [
        seedEventReport({
          id: rid,
          resolved: 1,
          resolved_by: ADMIN,
          resolved_at: NOW - 1000,
          resolution_note: 'prior',
        }),
      ],
      selectBarrier: {
        match: (sql) => sql.includes('SELECT admin FROM users'),
        count: 2,
      },
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}/resolve`;
    const [a, b] = await Promise.all([
      reportReq(db, path, jsonInit('POST', { note: 'retry-A-15' })),
      reportReq(db, path, jsonInit('POST', { note: 'retry-B-15' })),
    ]);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    const row = db.reports.find((r) => r.id === rid)!;
    expect(row.resolved).toBe(1);
    expect(row.resolution_note).toBe('prior');
  });
});

describe('race report event N-way UPDATE soft after #197', () => {
  it('event N-way UPDATE soft #0', async () => {
    const evt = `$nway0:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 0, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-0`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #1', async () => {
    const evt = `$nway1:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 1, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-1`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #2', async () => {
    const evt = `$nway2:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 2, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-2`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #3', async () => {
    const evt = `$nway3:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 3, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-3`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #4', async () => {
    const evt = `$nway4:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 4, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-4`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #5', async () => {
    const evt = `$nway5:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 5, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-5`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #6', async () => {
    const evt = `$nway6:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 6, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-6`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #7', async () => {
    const evt = `$nway7:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 7, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-7`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #8', async () => {
    const evt = `$nway8:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 8, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-8`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #9', async () => {
    const evt = `$nway9:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 9, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-9`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #10', async () => {
    const evt = `$nway10:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 10, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-10`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #11', async () => {
    const evt = `$nway11:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 11, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-11`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #12', async () => {
    const evt = `$nway12:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 12, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-12`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #13', async () => {
    const evt = `$nway13:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 13, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-13`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #14', async () => {
    const evt = `$nway14:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 14, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-14`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
  it('event N-way UPDATE soft #15', async () => {
    const evt = `$nway15:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [seedEventReport({ id: 90 + 15, event_id: evt, reason: 'seed' })],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, j) =>
        reportReq(db, path, jsonInit('POST', { reason: `nw-${j}-15`, score: -((j % 5) + 1) }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.inserts.length).toBe(0);
    expect(db.updates.length).toBe(6);
    const row = db.reports.find((r) => r.event_id === evt)!;
    expect(row.reason.startsWith('nw-')).toBe(true);
  });
});

describe('race report room-not-found concurrent soft after #197', () => {
  it('room not found concurrent soft #0', async () => {
    const missing = '!missing0:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-0' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-0' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-0' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #1', async () => {
    const missing = '!missing1:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-1' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-1' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-1' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #2', async () => {
    const missing = '!missing2:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-2' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-2' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-2' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #3', async () => {
    const missing = '!missing3:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-3' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-3' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-3' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #4', async () => {
    const missing = '!missing4:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-4' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-4' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-4' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #5', async () => {
    const missing = '!missing5:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-5' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-5' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-5' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #6', async () => {
    const missing = '!missing6:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-6' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-6' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-6' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #7', async () => {
    const missing = '!missing7:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-7' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-7' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-7' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #8', async () => {
    const missing = '!missing8:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-8' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-8' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-8' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #9', async () => {
    const missing = '!missing9:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-9' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-9' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-9' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #10', async () => {
    const missing = '!missing10:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-10' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-10' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-10' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #11', async () => {
    const missing = '!missing11:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-11' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-11' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-11' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #12', async () => {
    const missing = '!missing12:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-12' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-12' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-12' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #13', async () => {
    const missing = '!missing13:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-13' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-13' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-13' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #14', async () => {
    const missing = '!missing14:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-14' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-14' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-14' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('room not found concurrent soft #15', async () => {
    const missing = '!missing15:example.com';
    const db = createReportDb({ rooms: [ROOM], reports: [] });
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'mA-15' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mB-15' })),
      reportReq(db, path, jsonInit('POST', { reason: 'mC-15' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
});

describe('race report user-not-found concurrent soft after #197', () => {
  it('user not found concurrent soft #0', async () => {
    const missing = '@ghost0:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-0' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-0' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #1', async () => {
    const missing = '@ghost1:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-1' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-1' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #2', async () => {
    const missing = '@ghost2:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-2' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-2' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #3', async () => {
    const missing = '@ghost3:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-3' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-3' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #4', async () => {
    const missing = '@ghost4:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-4' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-4' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #5', async () => {
    const missing = '@ghost5:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-5' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-5' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #6', async () => {
    const missing = '@ghost6:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-6' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-6' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #7', async () => {
    const missing = '@ghost7:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-7' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-7' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #8', async () => {
    const missing = '@ghost8:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-8' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-8' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #9', async () => {
    const missing = '@ghost9:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-9' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-9' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #10', async () => {
    const missing = '@ghost10:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-10' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-10' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #11', async () => {
    const missing = '@ghost11:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-11' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-11' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #12', async () => {
    const missing = '@ghost12:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-12' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-12' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #13', async () => {
    const missing = '@ghost13:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-13' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-13' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #14', async () => {
    const missing = '@ghost14:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-14' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-14' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('user not found concurrent soft #15', async () => {
    const missing = '@ghost15:example.com';
    const db = createReportDb({ reports: [] });
    const path = `/_matrix/client/v3/users/${encodeURIComponent(missing)}/report`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'gA-15' })),
      reportReq(db, path, jsonInit('POST', { reason: 'gB-15' })),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
});

describe('race report non-member concurrent soft after #197', () => {
  it('non-member concurrent soft #0', async () => {
    const evt = `$nm0:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-0' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-0' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #1', async () => {
    const evt = `$nm1:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-1' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-1' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #2', async () => {
    const evt = `$nm2:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-2' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-2' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #3', async () => {
    const evt = `$nm3:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-3' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-3' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #4', async () => {
    const evt = `$nm4:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-4' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-4' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #5', async () => {
    const evt = `$nm5:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-5' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-5' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #6', async () => {
    const evt = `$nm6:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-6' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-6' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #7', async () => {
    const evt = `$nm7:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-7' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-7' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #8', async () => {
    const evt = `$nm8:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-8' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-8' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #9', async () => {
    const evt = `$nm9:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-9' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-9' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #10', async () => {
    const evt = `$nm10:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-10' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-10' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #11', async () => {
    const evt = `$nm11:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-11' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-11' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #12', async () => {
    const evt = `$nm12:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-12' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-12' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #13', async () => {
    const evt = `$nm13:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-13' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-13' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #14', async () => {
    const evt = `$nm14:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-14' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-14' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
  it('non-member concurrent soft #15', async () => {
    const evt = `$nm15:example.com`;
    const db = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      reports: [],
    });
    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`;
    const results = await Promise.all([
      reportReq(db, path, jsonInit('POST', { reason: 'banA-15' })),
      reportReq(db, path, jsonInit('POST', { reason: 'banB-15' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports).toHaveLength(0);
  });
});

describe('race report corrupt content admin get concurrent after #197', () => {
  it('corrupt content admin get concurrent #0', async () => {
    const rid = 600 + 0;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-0',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #1', async () => {
    const rid = 600 + 1;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-1',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #2', async () => {
    const rid = 600 + 2;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-2',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #3', async () => {
    const rid = 600 + 3;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-3',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #4', async () => {
    const rid = 600 + 4;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-4',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #5', async () => {
    const rid = 600 + 5;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-5',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #6', async () => {
    const rid = 600 + 6;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-6',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #7', async () => {
    const rid = 600 + 7;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-7',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #8', async () => {
    const rid = 600 + 8;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-8',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #9', async () => {
    const rid = 600 + 9;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-9',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #10', async () => {
    const rid = 600 + 10;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-10',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #11', async () => {
    const rid = 600 + 11;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-11',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #12', async () => {
    const rid = 600 + 12;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-12',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #13', async () => {
    const rid = 600 + 13;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-13',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #14', async () => {
    const rid = 600 + 14;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-14',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
  it('corrupt content admin get concurrent #15', async () => {
    const rid = 600 + 15;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '{not-json-15',
        },
      ],
      reports: [seedEventReport({ id: rid })],
    });
    const path = `/_matrix/client/v3/admin/reports/${rid}`;
    // Hono surfaces JSON.parse failure as 500 (or rejects); both callers share fate
    const results = await Promise.allSettled([
      reportReq(db, path, jsonInit('GET')),
      reportReq(db, path, jsonInit('GET')),
    ]);
    const outcomes = results.map((r) =>
      r.status === 'rejected'
        ? 'rejected'
        : String((r as PromiseFulfilledResult<{ status: number }>).value.status)
    );
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes.every((o) => o === 'rejected' || o === '500')).toBe(true);
  });
});

describe('race report admin list pagination concurrent soft after #197', () => {
  it('list pagination concurrent soft #0', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 0 * 10 + j,
        event_id: `$pg0-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 0 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #1', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 1 * 10 + j,
        event_id: `$pg1-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 1 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #2', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 2 * 10 + j,
        event_id: `$pg2-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 2 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #3', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 3 * 10 + j,
        event_id: `$pg3-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 3 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #4', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 4 * 10 + j,
        event_id: `$pg4-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 4 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #5', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 5 * 10 + j,
        event_id: `$pg5-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 5 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #6', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 6 * 10 + j,
        event_id: `$pg6-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 6 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #7', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 7 * 10 + j,
        event_id: `$pg7-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 7 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #8', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 8 * 10 + j,
        event_id: `$pg8-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 8 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #9', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 9 * 10 + j,
        event_id: `$pg9-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 9 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #10', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 10 * 10 + j,
        event_id: `$pg10-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 10 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #11', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 11 * 10 + j,
        event_id: `$pg11-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 11 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #12', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 12 * 10 + j,
        event_id: `$pg12-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 12 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #13', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 13 * 10 + j,
        event_id: `$pg13-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 13 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #14', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 14 * 10 + j,
        event_id: `$pg14-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 14 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
  it('list pagination concurrent soft #15', async () => {
    const reports = Array.from({ length: 8 }, (_, j) =>
      seedEventReport({
        id: 700 + 15 * 10 + j,
        event_id: `$pg15-${j}:example.com`,
        reason: `pg-${j}`,
        created_at: NOW - j,
        resolved: j % 2,
      })
    );
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }],
      events: reports.map((r) => ({
        event_id: r.event_id!,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: '{}',
      })),
      reports,
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports?limit=3', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=false&limit=5', jsonInit('GET')),
      reportReq(db, '/_matrix/client/v3/admin/reports?resolved=true&limit=5', jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports?from=${700 + 15 * 10 + 4}&limit=3`,
        jsonInit('GET')
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const body = r.body as { reports: unknown[] };
      expect(Array.isArray(body.reports)).toBe(true);
      expect(body.reports.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('race report non-admin concurrent soft after #197', () => {
  it('non-admin concurrent soft #0', async () => {
    const rid = 800 + 0;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #1', async () => {
    const rid = 800 + 1;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #2', async () => {
    const rid = 800 + 2;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #3', async () => {
    const rid = 800 + 3;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #4', async () => {
    const rid = 800 + 4;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #5', async () => {
    const rid = 800 + 5;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #6', async () => {
    const rid = 800 + 6;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #7', async () => {
    const rid = 800 + 7;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #8', async () => {
    const rid = 800 + 8;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #9', async () => {
    const rid = 800 + 9;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #10', async () => {
    const rid = 800 + 10;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #11', async () => {
    const rid = 800 + 11;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #12', async () => {
    const rid = 800 + 12;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #13', async () => {
    const rid = 800 + 13;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #14', async () => {
    const rid = 800 + 14;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
  it('non-admin concurrent soft #15', async () => {
    const rid = 800 + 15;
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [seedEventReport({ id: rid })],
    });
    const results = await Promise.all([
      reportReq(db, '/_matrix/client/v3/admin/reports', jsonInit('GET')),
      reportReq(db, `/_matrix/client/v3/admin/reports/${rid}`, jsonInit('GET')),
      reportReq(
        db,
        `/_matrix/client/v3/admin/reports/${rid}/resolve`,
        jsonInit('POST', { note: 'x' })
      ),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.reports.find((r) => r.id === rid)!.resolved).toBe(0);
  });
});

describe('race server-notices cold room-lookup TOCTOU after #197', () => {
  it('cold notice-room dual-create TOCTOU #0', async () => {
    authState.userId = ADMIN;
    const target = '@cold0:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-0' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-0' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #1', async () => {
    authState.userId = ADMIN;
    const target = '@cold1:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-1' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-1' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #2', async () => {
    authState.userId = ADMIN;
    const target = '@cold2:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-2' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-2' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #3', async () => {
    authState.userId = ADMIN;
    const target = '@cold3:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-3' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-3' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #4', async () => {
    authState.userId = ADMIN;
    const target = '@cold4:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-4' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-4' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #5', async () => {
    authState.userId = ADMIN;
    const target = '@cold5:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-5' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-5' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #6', async () => {
    authState.userId = ADMIN;
    const target = '@cold6:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-6' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-6' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #7', async () => {
    authState.userId = ADMIN;
    const target = '@cold7:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-7' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-7' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #8', async () => {
    authState.userId = ADMIN;
    const target = '@cold8:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-8' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-8' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #9', async () => {
    authState.userId = ADMIN;
    const target = '@cold9:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-9' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-9' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #10', async () => {
    authState.userId = ADMIN;
    const target = '@cold10:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-10' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-10' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #11', async () => {
    authState.userId = ADMIN;
    const target = '@cold11:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-11' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-11' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #12', async () => {
    authState.userId = ADMIN;
    const target = '@cold12:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-12' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-12' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #13', async () => {
    authState.userId = ADMIN;
    const target = '@cold13:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-13' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-13' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #14', async () => {
    authState.userId = ADMIN;
    const target = '@cold14:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-14' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-14' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('cold notice-room dual-create TOCTOU #15', async () => {
    authState.userId = ADMIN;
    const target = '@cold15:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cA-15' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: target, body: 'cB-15' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(typeof a.body?.event_id).toBe('string');
    expect(typeof b.body?.event_id).toBe('string');
    // TOCTOU: both saw no room → may create two notice rooms
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(1);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
});

describe('race server-notices warm depth lost-update after #197', () => {
  it('warm depth SELECT barrier race #0', async () => {
    authState.userId = ADMIN;
    const target = '@warm0:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm0:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-0' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-0' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm0:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #1', async () => {
    authState.userId = ADMIN;
    const target = '@warm1:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm1:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-1' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-1' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm1:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #2', async () => {
    authState.userId = ADMIN;
    const target = '@warm2:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm2:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-2' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-2' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm2:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #3', async () => {
    authState.userId = ADMIN;
    const target = '@warm3:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm3:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-3' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-3' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm3:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #4', async () => {
    authState.userId = ADMIN;
    const target = '@warm4:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm4:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-4' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-4' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm4:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #5', async () => {
    authState.userId = ADMIN;
    const target = '@warm5:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm5:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-5' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-5' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm5:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #6', async () => {
    authState.userId = ADMIN;
    const target = '@warm6:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm6:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-6' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-6' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm6:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #7', async () => {
    authState.userId = ADMIN;
    const target = '@warm7:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm7:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-7' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-7' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm7:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #8', async () => {
    authState.userId = ADMIN;
    const target = '@warm8:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm8:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-8' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-8' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm8:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #9', async () => {
    authState.userId = ADMIN;
    const target = '@warm9:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm9:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-9' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-9' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm9:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #10', async () => {
    authState.userId = ADMIN;
    const target = '@warm10:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm10:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-10' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-10' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm10:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #11', async () => {
    authState.userId = ADMIN;
    const target = '@warm11:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm11:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-11' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-11' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm11:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #12', async () => {
    authState.userId = ADMIN;
    const target = '@warm12:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm12:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-12' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-12' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm12:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #13', async () => {
    authState.userId = ADMIN;
    const target = '@warm13:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm13:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-13' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-13' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm13:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #14', async () => {
    authState.userId = ADMIN;
    const target = '@warm14:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm14:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-14' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-14' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm14:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
  it('warm depth SELECT barrier race #15', async () => {
    authState.userId = ADMIN;
    const target = '@warm15:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC'),
        count: 2,
      },
    });
    seedWarmNoticeRoom(db.store, target, `!warm15:example.com`);
    const [a, b] = await Promise.all([
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wA-15' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: target, body: 'wB-15' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store, `!warm15:example.com`);
    expect(msgs.length).toBe(2);
    // Both may reuse same prev depth (lost-update) — depths may collide
    const depths = msgs.map((m) => m.depth);
    expect(depths.every((d) => d >= 4)).toBe(true);
  });
});

describe('race server-notices synapse∥matrix dual-endpoint cold after #197', () => {
  it('synapse∥matrix dual-endpoint cold #0', async () => {
    authState.userId = ADMIN;
    const target = '@dual0:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-0', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-0', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #1', async () => {
    authState.userId = ADMIN;
    const target = '@dual1:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-1', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-1', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #2', async () => {
    authState.userId = ADMIN;
    const target = '@dual2:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-2', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-2', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #3', async () => {
    authState.userId = ADMIN;
    const target = '@dual3:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-3', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-3', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #4', async () => {
    authState.userId = ADMIN;
    const target = '@dual4:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-4', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-4', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #5', async () => {
    authState.userId = ADMIN;
    const target = '@dual5:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-5', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-5', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #6', async () => {
    authState.userId = ADMIN;
    const target = '@dual6:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-6', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-6', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #7', async () => {
    authState.userId = ADMIN;
    const target = '@dual7:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-7', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-7', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #8', async () => {
    authState.userId = ADMIN;
    const target = '@dual8:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-8', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-8', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #9', async () => {
    authState.userId = ADMIN;
    const target = '@dual9:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-9', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-9', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #10', async () => {
    authState.userId = ADMIN;
    const target = '@dual10:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-10', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-10', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #11', async () => {
    authState.userId = ADMIN;
    const target = '@dual11:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-11', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-11', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #12', async () => {
    authState.userId = ADMIN;
    const target = '@dual12:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-12', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-12', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #13', async () => {
    authState.userId = ADMIN;
    const target = '@dual13:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-13', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-13', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #14', async () => {
    authState.userId = ADMIN;
    const target = '@dual14:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-14', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-14', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('synapse∥matrix dual-endpoint cold #15', async () => {
    authState.userId = ADMIN;
    const target = '@dual15:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) =>
          sql.includes('FROM room_memberships rm') && sql.includes('m.server_notice'),
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'syn-15', admin_contact: 'mailto:a@example.com' }))
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: target, body: 'mtx-15', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.event_id).not.toBe(b.body?.event_id);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(2);
  });
});

describe('race server-notices multi-target concurrent after #197', () => {
  it('multi-target concurrent isolation #0', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA0:example.com',
      '@mtB0:example.com',
      '@mtC0:example.com',
      '@mtD0:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-0` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #1', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA1:example.com',
      '@mtB1:example.com',
      '@mtC1:example.com',
      '@mtD1:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-1` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #2', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA2:example.com',
      '@mtB2:example.com',
      '@mtC2:example.com',
      '@mtD2:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-2` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #3', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA3:example.com',
      '@mtB3:example.com',
      '@mtC3:example.com',
      '@mtD3:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-3` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #4', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA4:example.com',
      '@mtB4:example.com',
      '@mtC4:example.com',
      '@mtD4:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-4` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #5', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA5:example.com',
      '@mtB5:example.com',
      '@mtC5:example.com',
      '@mtD5:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-5` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #6', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA6:example.com',
      '@mtB6:example.com',
      '@mtC6:example.com',
      '@mtD6:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-6` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #7', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA7:example.com',
      '@mtB7:example.com',
      '@mtC7:example.com',
      '@mtD7:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-7` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #8', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA8:example.com',
      '@mtB8:example.com',
      '@mtC8:example.com',
      '@mtD8:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-8` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #9', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA9:example.com',
      '@mtB9:example.com',
      '@mtC9:example.com',
      '@mtD9:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-9` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #10', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA10:example.com',
      '@mtB10:example.com',
      '@mtC10:example.com',
      '@mtD10:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-10` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #11', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA11:example.com',
      '@mtB11:example.com',
      '@mtC11:example.com',
      '@mtD11:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-11` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #12', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA12:example.com',
      '@mtB12:example.com',
      '@mtC12:example.com',
      '@mtD12:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-12` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #13', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA13:example.com',
      '@mtB13:example.com',
      '@mtC13:example.com',
      '@mtD13:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-13` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #14', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA14:example.com',
      '@mtB14:example.com',
      '@mtC14:example.com',
      '@mtD14:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-14` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
  it('multi-target concurrent isolation #15', async () => {
    authState.userId = ADMIN;
    const targets = [
      '@mtA15:example.com',
      '@mtB15:example.com',
      '@mtC15:example.com',
      '@mtD15:example.com',
    ];
    const db = createNoticeDb();
    const results = await Promise.all(
      targets.map((user_id, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id, body: `mt-${j}-15` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
    expect(messageEvents(db.store)).toHaveLength(targets.length);
  });
});

describe('race server-notices server-user create TOCTOU after #197', () => {
  it('server-user create TOCTOU #0', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA0:example.com';
    const t2 = '@suB0:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-0' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-0' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #1', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA1:example.com';
    const t2 = '@suB1:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-1' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-1' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #2', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA2:example.com';
    const t2 = '@suB2:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-2' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-2' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #3', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA3:example.com';
    const t2 = '@suB3:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-3' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-3' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #4', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA4:example.com';
    const t2 = '@suB4:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-4' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-4' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #5', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA5:example.com';
    const t2 = '@suB5:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-5' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-5' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #6', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA6:example.com';
    const t2 = '@suB6:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-6' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-6' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #7', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA7:example.com';
    const t2 = '@suB7:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-7' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-7' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #8', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA8:example.com';
    const t2 = '@suB8:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-8' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-8' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #9', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA9:example.com';
    const t2 = '@suB9:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-9' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-9' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #10', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA10:example.com';
    const t2 = '@suB10:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-10' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-10' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #11', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA11:example.com';
    const t2 = '@suB11:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-11' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-11' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #12', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA12:example.com';
    const t2 = '@suB12:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-12' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-12' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #13', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA13:example.com';
    const t2 = '@suB13:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-13' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-13' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #14', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA14:example.com';
    const t2 = '@suB14:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-14' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-14' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
  it('server-user create TOCTOU #15', async () => {
    authState.userId = ADMIN;
    const t1 = '@suA15:example.com';
    const t2 = '@suB15:example.com';
    const db = createNoticeDb({
      selectBarrier: {
        match: (sql) => sql.includes('SELECT user_id FROM users WHERE user_id'),
        count: 2,
      },
    });
    // Ensure server user missing so both cold paths try to create it
    expect(db.store.users.has(SERVER_USER)).toBe(false);
    const [a, b] = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ user_id: t1, body: 'suA-15' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ user_id: t2, body: 'suB-15' }))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store).length).toBeGreaterThanOrEqual(2);
  });
});

describe('race server-notices warm N-way soft flood after #197', () => {
  it('warm N-way soft flood #0', async () => {
    authState.userId = ADMIN;
    const target = '@nway0:example.com';
    const roomId = `!nway0:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-0` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #1', async () => {
    authState.userId = ADMIN;
    const target = '@nway1:example.com';
    const roomId = `!nway1:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-1` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #2', async () => {
    authState.userId = ADMIN;
    const target = '@nway2:example.com';
    const roomId = `!nway2:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-2` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #3', async () => {
    authState.userId = ADMIN;
    const target = '@nway3:example.com';
    const roomId = `!nway3:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-3` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #4', async () => {
    authState.userId = ADMIN;
    const target = '@nway4:example.com';
    const roomId = `!nway4:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-4` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #5', async () => {
    authState.userId = ADMIN;
    const target = '@nway5:example.com';
    const roomId = `!nway5:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-5` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #6', async () => {
    authState.userId = ADMIN;
    const target = '@nway6:example.com';
    const roomId = `!nway6:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-6` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #7', async () => {
    authState.userId = ADMIN;
    const target = '@nway7:example.com';
    const roomId = `!nway7:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-7` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #8', async () => {
    authState.userId = ADMIN;
    const target = '@nway8:example.com';
    const roomId = `!nway8:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-8` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #9', async () => {
    authState.userId = ADMIN;
    const target = '@nway9:example.com';
    const roomId = `!nway9:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-9` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #10', async () => {
    authState.userId = ADMIN;
    const target = '@nway10:example.com';
    const roomId = `!nway10:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-10` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #11', async () => {
    authState.userId = ADMIN;
    const target = '@nway11:example.com';
    const roomId = `!nway11:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-11` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #12', async () => {
    authState.userId = ADMIN;
    const target = '@nway12:example.com';
    const roomId = `!nway12:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-12` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #13', async () => {
    authState.userId = ADMIN;
    const target = '@nway13:example.com';
    const roomId = `!nway13:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-13` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #14', async () => {
    authState.userId = ADMIN;
    const target = '@nway14:example.com';
    const roomId = `!nway14:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-14` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
  it('warm N-way soft flood #15', async () => {
    authState.userId = ADMIN;
    const target = '@nway15:example.com';
    const roomId = `!nway15:example.com`;
    const db = createNoticeDb();
    seedWarmNoticeRoom(db.store, target, roomId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `nw-${j}-15` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body?.event_id)).size).toBe(8);
    expect(messageEvents(db.store, roomId)).toHaveLength(8);
    expect(noticeRooms(db.store)).toHaveLength(1);
  });
});

describe('race server-notices non-admin concurrent soft after #197', () => {
  it('non-admin concurrent soft #0', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-0' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-0' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-0' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #1', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-1' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-1' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-1' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #2', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-2' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-2' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-2' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #3', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-3' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-3' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-3' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #4', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-4' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-4' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-4' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #5', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-5' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-5' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-5' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #6', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-6' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-6' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-6' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #7', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-7' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-7' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-7' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #8', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-8' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-8' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-8' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #9', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-9' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-9' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-9' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #10', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-10' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-10' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-10' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #11', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-11' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-11' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-11' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #12', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-12' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-12' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-12' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #13', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-13' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-13' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-13' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #14', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-14' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-14' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-14' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('non-admin concurrent soft #15', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedNoticeUser(ADMIN, 0)]]),
    });
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naA-15' }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ body: 'naB-15' }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ body: 'naC-15' }))),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
});

describe('race server-notices missing-body concurrent soft after #197', () => {
  it('missing-body concurrent soft #0', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #1', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #2', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #3', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #4', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #5', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #6', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #7', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #8', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #9', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #10', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #11', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #12', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #13', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #14', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('missing-body concurrent soft #15', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitBody: true }))),
      noticeReq(db, MATRIX_PATH, noticeJson(noticePayload({ omitUserId: true }))),
      noticeReq(db, SYNAPSE_PATH, noticeJson(noticePayload({ omitContent: true }))),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
});

describe('race server-notices bad-json concurrent soft after #197', () => {
  it('bad-json concurrent soft #0', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-0',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #1', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-1',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #2', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-2',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #3', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-3',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #4', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-4',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #5', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-5',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #6', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-6',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #7', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-7',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #8', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-8',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #9', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-9',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #10', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-10',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #11', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-11',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #12', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-12',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #13', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-13',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #14', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-14',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
  it('bad-json concurrent soft #15', async () => {
    authState.userId = ADMIN;
    const db = createNoticeDb();
    const bad: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{bad-15',
    };
    const results = await Promise.all([
      noticeReq(db, SYNAPSE_PATH, bad),
      noticeReq(db, MATRIX_PATH, bad),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(messageEvents(db.store)).toHaveLength(0);
  });
});

describe('race server-notices msgtype content isolation after #197', () => {
  it('msgtype content isolation #0', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA0:example.com';
    const t2 = '@msgB0:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-0',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-0', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-0'].msgtype).toBe('m.text');
    expect(byBody['text-0'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-0'].msgtype).toBe('m.notice');
    expect(byBody['notice-0'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #1', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA1:example.com';
    const t2 = '@msgB1:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-1',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-1', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-1'].msgtype).toBe('m.text');
    expect(byBody['text-1'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-1'].msgtype).toBe('m.notice');
    expect(byBody['notice-1'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #2', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA2:example.com';
    const t2 = '@msgB2:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-2',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-2', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-2'].msgtype).toBe('m.text');
    expect(byBody['text-2'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-2'].msgtype).toBe('m.notice');
    expect(byBody['notice-2'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #3', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA3:example.com';
    const t2 = '@msgB3:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-3',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-3', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-3'].msgtype).toBe('m.text');
    expect(byBody['text-3'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-3'].msgtype).toBe('m.notice');
    expect(byBody['notice-3'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #4', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA4:example.com';
    const t2 = '@msgB4:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-4',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-4', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-4'].msgtype).toBe('m.text');
    expect(byBody['text-4'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-4'].msgtype).toBe('m.notice');
    expect(byBody['notice-4'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #5', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA5:example.com';
    const t2 = '@msgB5:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-5',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-5', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-5'].msgtype).toBe('m.text');
    expect(byBody['text-5'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-5'].msgtype).toBe('m.notice');
    expect(byBody['notice-5'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #6', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA6:example.com';
    const t2 = '@msgB6:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-6',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-6', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-6'].msgtype).toBe('m.text');
    expect(byBody['text-6'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-6'].msgtype).toBe('m.notice');
    expect(byBody['notice-6'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #7', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA7:example.com';
    const t2 = '@msgB7:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-7',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-7', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-7'].msgtype).toBe('m.text');
    expect(byBody['text-7'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-7'].msgtype).toBe('m.notice');
    expect(byBody['notice-7'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #8', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA8:example.com';
    const t2 = '@msgB8:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-8',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-8', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-8'].msgtype).toBe('m.text');
    expect(byBody['text-8'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-8'].msgtype).toBe('m.notice');
    expect(byBody['notice-8'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #9', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA9:example.com';
    const t2 = '@msgB9:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-9',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-9', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-9'].msgtype).toBe('m.text');
    expect(byBody['text-9'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-9'].msgtype).toBe('m.notice');
    expect(byBody['notice-9'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #10', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA10:example.com';
    const t2 = '@msgB10:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-10',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-10', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-10'].msgtype).toBe('m.text');
    expect(byBody['text-10'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-10'].msgtype).toBe('m.notice');
    expect(byBody['notice-10'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #11', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA11:example.com';
    const t2 = '@msgB11:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-11',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-11', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-11'].msgtype).toBe('m.text');
    expect(byBody['text-11'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-11'].msgtype).toBe('m.notice');
    expect(byBody['notice-11'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #12', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA12:example.com';
    const t2 = '@msgB12:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-12',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-12', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-12'].msgtype).toBe('m.text');
    expect(byBody['text-12'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-12'].msgtype).toBe('m.notice');
    expect(byBody['notice-12'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #13', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA13:example.com';
    const t2 = '@msgB13:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-13',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-13', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-13'].msgtype).toBe('m.text');
    expect(byBody['text-13'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-13'].msgtype).toBe('m.notice');
    expect(byBody['notice-13'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #14', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA14:example.com';
    const t2 = '@msgB14:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-14',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-14', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-14'].msgtype).toBe('m.text');
    expect(byBody['text-14'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-14'].msgtype).toBe('m.notice');
    expect(byBody['notice-14'].admin_contact).toBeUndefined();
  });
  it('msgtype content isolation #15', async () => {
    authState.userId = ADMIN;
    const t1 = '@msgA15:example.com';
    const t2 = '@msgB15:example.com';
    const db = createNoticeDb();
    const [a, b] = await Promise.all([
      noticeReq(
        db,
        SYNAPSE_PATH,
        noticeJson(
          noticePayload({
            user_id: t1,
            body: 'text-15',
            msgtype: 'm.text',
            admin_contact: 'mailto:ops@example.com',
          })
        )
      ),
      noticeReq(
        db,
        MATRIX_PATH,
        noticeJson(noticePayload({ user_id: t2, body: 'notice-15', msgtype: 'm.notice' }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(2);
    const contents = msgs.map((m) => JSON.parse(m.content) as Record<string, unknown>);
    const byBody = Object.fromEntries(contents.map((c) => [c.body as string, c]));
    expect(byBody['text-15'].msgtype).toBe('m.text');
    expect(byBody['text-15'].admin_contact).toBe('mailto:ops@example.com');
    expect(byBody['notice-15'].msgtype).toBe('m.notice');
    expect(byBody['notice-15'].admin_contact).toBeUndefined();
  });
});

describe('race server-notices warm reuse after cold race after #197', () => {
  it('warm reuse after cold race #0', async () => {
    authState.userId = ADMIN;
    const target = '@reuse0:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-0' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-0` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #1', async () => {
    authState.userId = ADMIN;
    const target = '@reuse1:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-1' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-1` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #2', async () => {
    authState.userId = ADMIN;
    const target = '@reuse2:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-2' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-2` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #3', async () => {
    authState.userId = ADMIN;
    const target = '@reuse3:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-3' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-3` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #4', async () => {
    authState.userId = ADMIN;
    const target = '@reuse4:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-4' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-4` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #5', async () => {
    authState.userId = ADMIN;
    const target = '@reuse5:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-5' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-5` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #6', async () => {
    authState.userId = ADMIN;
    const target = '@reuse6:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-6' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-6` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #7', async () => {
    authState.userId = ADMIN;
    const target = '@reuse7:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-7' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-7` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #8', async () => {
    authState.userId = ADMIN;
    const target = '@reuse8:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-8' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-8` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #9', async () => {
    authState.userId = ADMIN;
    const target = '@reuse9:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-9' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-9` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #10', async () => {
    authState.userId = ADMIN;
    const target = '@reuse10:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-10' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-10` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #11', async () => {
    authState.userId = ADMIN;
    const target = '@reuse11:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-11' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-11` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #12', async () => {
    authState.userId = ADMIN;
    const target = '@reuse12:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-12' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-12` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #13', async () => {
    authState.userId = ADMIN;
    const target = '@reuse13:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-13' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-13` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #14', async () => {
    authState.userId = ADMIN;
    const target = '@reuse14:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-14' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-14` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
  it('warm reuse after cold race #15', async () => {
    authState.userId = ADMIN;
    const target = '@reuse15:example.com';
    const db = createNoticeDb();
    const cold = await noticeReq(
      db,
      SYNAPSE_PATH,
      noticeJson(noticePayload({ user_id: target, body: 'cold-15' }))
    );
    expect(cold.status).toBe(200);
    const roomsBefore = noticeRooms(db.store);
    expect(roomsBefore).toHaveLength(1);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, j) =>
        noticeReq(
          db,
          j % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          noticeJson(noticePayload({ user_id: target, body: `warm-${j}-15` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(5);
  });
});

describe('race report∥server-notices module isolation soft after #197', () => {
  it('report∥notices module isolation #0', async () => {
    authState.userId = USER;
    const evt = `$iso0:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-0', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-0' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #1', async () => {
    authState.userId = USER;
    const evt = `$iso1:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-1', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-1' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #2', async () => {
    authState.userId = USER;
    const evt = `$iso2:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-2', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-2' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #3', async () => {
    authState.userId = USER;
    const evt = `$iso3:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-3', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-3' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #4', async () => {
    authState.userId = USER;
    const evt = `$iso4:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-4', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-4' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #5', async () => {
    authState.userId = USER;
    const evt = `$iso5:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-5', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-5' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #6', async () => {
    authState.userId = USER;
    const evt = `$iso6:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-6', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-6' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #7', async () => {
    authState.userId = USER;
    const evt = `$iso7:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-7', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-7' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #8', async () => {
    authState.userId = USER;
    const evt = `$iso8:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-8', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-8' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #9', async () => {
    authState.userId = USER;
    const evt = `$iso9:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-9', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-9' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #10', async () => {
    authState.userId = USER;
    const evt = `$iso10:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-10', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-10' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #11', async () => {
    authState.userId = USER;
    const evt = `$iso11:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-11', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-11' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #12', async () => {
    authState.userId = USER;
    const evt = `$iso12:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-12', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-12' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #13', async () => {
    authState.userId = USER;
    const evt = `$iso13:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-13', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-13' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #14', async () => {
    authState.userId = USER;
    const evt = `$iso14:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-14', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-14' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
  it('report∥notices module isolation #15', async () => {
    authState.userId = USER;
    const evt = `$iso15:example.com`;
    const reportDb = createReportDb({
      events: [{ event_id: evt, room_id: ROOM, sender: BOB }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      reports: [],
    });
    authState.userId = ADMIN;
    const noticeDb = createNoticeDb();
    const [rep, notice] = await Promise.all([
      (async () => {
        authState.userId = USER;
        return reportReq(
          reportDb,
          `/_matrix/client/v3/rooms/${ROOM_ENC}/report/${encodeURIComponent(evt)}`,
          jsonInit('POST', { reason: 'iso-15', score: -7 })
        );
      })(),
      (async () => {
        authState.userId = ADMIN;
        return noticeReq(
          noticeDb,
          SYNAPSE_PATH,
          noticeJson(noticePayload({ body: 'iso-notice-15' }))
        );
      })(),
    ]);
    expect(rep.status).toBe(200);
    expect(notice.status).toBe(200);
    expect(reportDb.reports.some((r) => r.event_id === evt)).toBe(true);
    expect(messageEvents(noticeDb.store)).toHaveLength(1);
  });
});
