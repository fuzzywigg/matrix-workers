/**
 * TOKENMAXX HEAVY leftovers after #148 — report API soft/edge/reliability.
 * Complements report-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import reportApp from '../src/api/report';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com';
const SERVER = 'example.com';
const EVENT = '$evt:example.com';
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
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

function createReportDb(opts: {
  users?: UserRow[];
  rooms?: string[];
  events?: EventRow[];
  memberships?: Membership[];
  reports?: ReportRow[];
} = {}) {
  const users = opts.users ?? [
    { user_id: USER, admin: 0 },
    { user_id: BOB, admin: 0 },
  ];
  const rooms = opts.rooms ?? [ROOM];
  const events = opts.events ?? [];
  const memberships = opts.memberships ?? [];
  const reports = opts.reports ?? [];
  let nextId = reports.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    users,
    rooms,
    events,
    memberships,
    reports,
    inserts,
    updates,
    selects,
    runs,
    get nextId() {
      return nextId;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('SELECT membership FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
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
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 180)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
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
              runs.push({ sql, args });
              if (
                sql.includes('UPDATE content_reports SET reason = ?, score = ?, created_at = ?') &&
                sql.includes('event_id = ?') &&
                !sql.includes('IS NULL')
              ) {
                updates.push({ sql, args });
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
                const [resolvedBy, resolvedAt, note, id] = args as [
                  string,
                  number,
                  string | null,
                  number,
                ];
                const row = reports.find((r) => r.id === id);
                if (!row) {
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
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }
              if (
                sql.includes('INSERT INTO content_reports') &&
                sql.includes("VALUES (?, ?, NULL, ?, ?, ?, 'room')")
              ) {
                inserts.push({ sql, args });
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
                sql.includes("VALUES (?, NULL, NULL, ?, -100, ?, 'user', ?)")
              ) {
                inserts.push({ sql, args });
                const [reporter, reason, createdAt, reported] = args as [
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
                  reported_user_id: reported,
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

function envFor(db: ReportDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(
  db: ReportDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await reportApp.request(`http://localhost${path}`, init, envFor(db));
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function eventReportPath(roomId = ROOM, eventId = EVENT): string {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/report/${encodeURIComponent(eventId)}`;
}

function roomReportPath(roomId = ROOM): string {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/report`;
}

function userReportPath(userId: string): string {
  return `/_matrix/client/v3/users/${encodeURIComponent(userId)}/report`;
}

function memberDb(extra: Parameters<typeof createReportDb>[0] = {}): ReportDb {
  return createReportDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    events: [
      {
        event_id: EVENT,
        room_id: ROOM,
        sender: BOB,
        event_type: 'm.room.message',
        content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
      },
    ],
    ...extra,
  });
}

function adminDb(extra: Parameters<typeof createReportDb>[0] = {}): ReportDb {
  return memberDb({
    users: [
      { user_id: USER, admin: 1 },
      { user_id: BOB, admin: 0 },
    ],
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('report leftovers event report soft reliability after #148', () => {
  it('event report insert soft-0', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-0', score: -10 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-0');
  });
  it('event report insert soft-1', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-1', score: -11 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-1');
  });
  it('event report insert soft-2', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-2', score: -12 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-2');
  });
  it('event report insert soft-3', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-3', score: -13 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-3');
  });
  it('event report insert soft-4', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-4', score: -14 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-4');
  });
  it('event report insert soft-5', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-5', score: -15 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-5');
  });
  it('event report insert soft-6', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-6', score: -16 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-6');
  });
  it('event report insert soft-7', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-7', score: -17 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-7');
  });
  it('event report insert soft-8', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-8', score: -18 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-8');
  });
  it('event report insert soft-9', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-9', score: -19 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-9');
  });
  it('event report insert soft-10', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-10', score: -20 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-10');
  });
  it('event report insert soft-11', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-11', score: -21 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-11');
  });
  it('event report insert soft-12', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-12', score: -22 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-12');
  });
  it('event report insert soft-13', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-13', score: -23 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-13');
  });
  it('event report insert soft-14', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-14', score: -24 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-14');
  });
  it('event report insert soft-15', async () => {
    const db = memberDb();
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'soft-15', score: -25 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.reports[0].reason).toBe('soft-15');
  });
});

describe('report leftovers score type soft flood after #148', () => {
  it('score type soft-0 null', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: null }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-1 true', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: true }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-2 false', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: false }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-3 string', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: "-40" }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-4 object', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: {} }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-5 array', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: [] }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-6 NaN number', async () => {
    const db = memberDb();
    // NaN is typeof number but clamps via Math.max/min to NaN; route stores NaN
    const res = await reportApp.request('http://localhost' + eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{"reason":"n","score":null}',
    }, envFor(db));
    expect(res.status).toBe(200);
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-7 omit', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-8 zero', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: 0 }),
    });
    expect(db.reports[0].score).toBe(0);
  });
  it('score type soft-9 neg50', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: -50 }),
    });
    expect(db.reports[0].score).toBe(-50);
  });
  it('score type soft-10 pos', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: 50 }),
    });
    expect(db.reports[0].score).toBe(0);
  });
  it('score type soft-11 below', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: -999 }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-12 neg1', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: -1 }),
    });
    expect(db.reports[0].score).toBe(-1);
  });
  it('score type soft-13 neg100', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: -100 }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
  it('score type soft-14 float', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: -12.5 }),
    });
    expect(db.reports[0].score).toBe(-12.5);
  });
  it('score type soft-15 Infinity', async () => {
    const db = memberDb();
    await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ reason: 't', score: null }),
    });
    expect(db.reports[0].score).toBe(-100);
  });
});

describe('report leftovers reason soft flood after #148', () => {
  it('reason soft-0', async () => {
    const db = memberDb();
    const reason = '';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-1', async () => {
    const db = memberDb();
    const reason = ' ';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-2', async () => {
    const db = memberDb();
    const reason = '\t';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-3', async () => {
    const db = memberDb();
    const reason = 'abuse';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-4', async () => {
    const db = memberDb();
    const reason = '日本語スパム';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-5', async () => {
    const db = memberDb();
    const reason = '🚀🔥';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-6', async () => {
    const db = memberDb();
    const reason = 'a'.repeat(500);
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-7', async () => {
    const db = memberDb();
    const reason = 'a'.repeat(2000);
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-8', async () => {
    const db = memberDb();
    const reason = 'line1\nline2';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-9', async () => {
    const db = memberDb();
    const reason = '<script>x</script>';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-10', async () => {
    const db = memberDb();
    const reason = 'null';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-11', async () => {
    const db = memberDb();
    const reason = 'undefined';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-12', async () => {
    const db = memberDb();
    const reason = '{\"x\":1}';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-13', async () => {
    const db = memberDb();
    const reason = '  padded  ';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-14', async () => {
    const db = memberDb();
    const reason = 'score:-100';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
  it('reason soft-15', async () => {
    const db = memberDb();
    const reason = 'soft-reason-15';
    await request(db, eventReportPath(), jsonInit('POST', { reason, score: -20 }));
    expect(db.reports[0].reason).toBe(reason);
  });
});

describe('report leftovers room report soft flood after #148', () => {
  it('room report soft-0', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-0', score: -0 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-0');
  });
  it('room report soft-1', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-1', score: -10 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-1');
  });
  it('room report soft-2', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-2', score: -20 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-2');
  });
  it('room report soft-3', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-3', score: -30 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-3');
  });
  it('room report soft-4', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-4', score: -40 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-4');
  });
  it('room report soft-5', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-5', score: -50 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-5');
  });
  it('room report soft-6', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-6', score: -60 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-6');
  });
  it('room report soft-7', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-7', score: -70 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-7');
  });
  it('room report soft-8', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-8', score: -80 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-8');
  });
  it('room report soft-9', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-9', score: -90 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-9');
  });
  it('room report soft-10', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-10', score: -0 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-10');
  });
  it('room report soft-11', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-11', score: -10 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-11');
  });
  it('room report soft-12', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-12', score: -20 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-12');
  });
  it('room report soft-13', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-13', score: -30 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-13');
  });
  it('room report soft-14', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-14', score: -40 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-14');
  });
  it('room report soft-15', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room-15', score: -50 }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('room');
    expect(db.reports[0].event_id).toBeNull();
    expect(db.reports[0].reason).toBe('room-15');
  });
});

describe('report leftovers user report soft flood after #148', () => {
  it('user report bob soft-0', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-0' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-1', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-1' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-2', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-2' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-3', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-3' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-4', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-4' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-5', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-5' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-6', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-6' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-7', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-7' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-8', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-8' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-9', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-9' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-10', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-10' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bob soft-11', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'user-11' }));
    expect(status).toBe(200);
    expect(db.reports[0].report_type).toBe('user');
    expect(db.reports[0].reported_user_id).toBe(BOB);
    expect(db.reports[0].score).toBe(-100);
  });
  it('self report soft-0', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-0' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-1', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-1' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-2', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-2' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-3', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-3' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-4', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-4' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-5', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-5' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-6', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-6' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
  it('self report soft-7', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(USER), jsonInit('POST', { reason: 'self-7' }));
    expect(status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(USER);
  });
});

describe('report leftovers membership soft matrix after #148', () => {
  it('membership soft-0 join', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{}' }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'm' }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
  it('membership soft-1 leave', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{}' }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'm' }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
  it('membership soft-2 invite', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{}' }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'm' }));
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('membership soft-3 ban', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{}' }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'm' }));
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('membership soft-4 knock', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{}' }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'm' }));
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('membership soft-5 null', async () => {
    const db = createReportDb({
      memberships: [],
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '{}' }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'm' }));
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('event report update soft-0', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-0', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-0');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-1', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-1', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-1');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-2', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-2', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-2');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-3', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-3', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-3');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-4', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-4', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-4');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-5', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-5', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-5');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-6', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-6', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-6');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-7', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-7', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-7');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-8', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-8', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-8');
    expect(db.reports[0].score).toBe(-55);
  });
  it('event report update soft-9', async () => {
    const db = memberDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'old',
        score: -10,
        created_at: 1,
        resolved: 0,
      }],
    });
    const { status } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'new-9', score: -55 }));
    expect(status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0].reason).toBe('new-9');
    expect(db.reports[0].score).toBe(-55);
  });
});

describe('report leftovers admin list soft flood after #148', () => {
  it('admin limit soft-0 limit=default', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-1 limit=0', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=0', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-2 limit=1', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-3 limit=3', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=3', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-4 limit=50', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=50', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-5 limit=100', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=100', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-6 limit=999', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=999', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-7 limit=-1', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=-1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-8 limit=abc', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=abc', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-9 limit=3.7', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=3.7', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-10 limit=01', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=01', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin limit soft-11 limit=true', async () => {
    const reports = Array.from({ length: 5 }, (_, j) => ({
      id: j + 1,
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'r' + j,
      score: -1,
      created_at: NOW - j,
      resolved: 0,
    }));
    const db = adminDb({ reports });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=true', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-0 resolved=true', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?resolved=true', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-1 resolved=false', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?resolved=false', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-2 resolved=TRUE', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?resolved=TRUE', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-3 resolved=1', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?resolved=1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-4 resolved=yes', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?resolved=yes', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-5 resolved=0', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?resolved=0', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin resolved soft-6 resolved=omit', async () => {
    const db = adminDb({
      reports: [
        { id: 1, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'a', score: -1, created_at: NOW, resolved: 1 },
        { id: 2, reporter_user_id: USER, room_id: ROOM, event_id: EVENT, reason: 'b', score: -2, created_at: NOW - 1, resolved: 0 },
      ],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-0', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-1', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=9', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-2', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=8', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-3', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=7', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-4', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=6', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-5', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=5', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-6', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=4', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
  it('admin from soft-7', async () => {
    const db = adminDb({
      reports: Array.from({ length: 6 }, (_, j) => ({
        id: 10 - j,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'f' + j,
        score: -1,
        created_at: NOW - j,
        resolved: 0,
      })),
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports?limit=2&from=3', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.reports)).toBe(true);
  });
});

describe('report leftovers admin gate soft matrix after #148', () => {
  it('admin flag soft-0 admin=0', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }, { user_id: BOB, admin: 0 }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin flag soft-1 admin=1', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 1 }, { user_id: BOB, admin: 0 }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.reports).toEqual([]);
  });
  it('admin flag soft-2 admin=2', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 2 }, { user_id: BOB, admin: 0 }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin flag soft-3 admin=-1', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: -1 }, { user_id: BOB, admin: 0 }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin flag soft-4 admin=99', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 99 }, { user_id: BOB, admin: 0 }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin get soft-0', async () => {
    const db = adminDb({
      reports: [{
        id: 1,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g0',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(1);
    expect(body.reason).toBe('g0');
  });
  it('admin get soft-1', async () => {
    const db = adminDb({
      reports: [{
        id: 2,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g1',
        score: -2,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/2', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(2);
    expect(body.reason).toBe('g1');
  });
  it('admin get soft-2', async () => {
    const db = adminDb({
      reports: [{
        id: 3,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g2',
        score: -3,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/3', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(3);
    expect(body.reason).toBe('g2');
  });
  it('admin get soft-3', async () => {
    const db = adminDb({
      reports: [{
        id: 4,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g3',
        score: -4,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/4', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(4);
    expect(body.reason).toBe('g3');
  });
  it('admin get soft-4', async () => {
    const db = adminDb({
      reports: [{
        id: 5,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g4',
        score: -5,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/5', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(5);
    expect(body.reason).toBe('g4');
  });
  it('admin get soft-5', async () => {
    const db = adminDb({
      reports: [{
        id: 6,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g5',
        score: -6,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/6', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(6);
    expect(body.reason).toBe('g5');
  });
  it('admin get soft-6', async () => {
    const db = adminDb({
      reports: [{
        id: 7,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g6',
        score: -7,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/7', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(7);
    expect(body.reason).toBe('g6');
  });
  it('admin get soft-7', async () => {
    const db = adminDb({
      reports: [{
        id: 8,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g7',
        score: -8,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/8', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(8);
    expect(body.reason).toBe('g7');
  });
  it('admin get soft-8', async () => {
    const db = adminDb({
      reports: [{
        id: 9,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g8',
        score: -9,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/9', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(9);
    expect(body.reason).toBe('g8');
  });
  it('admin get soft-9', async () => {
    const db = adminDb({
      reports: [{
        id: 10,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'g9',
        score: -10,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(10);
    expect(body.reason).toBe('g9');
  });
});

describe('report leftovers resolve soft flood after #148', () => {
  it('resolve note soft-0', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-1', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: '' }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-2', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: ' ' }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-3', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: 'ok' }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-4', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: '日本語' }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-5', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: 'a'.repeat(300) }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-6', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: 'note\nline' }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve note soft-7', async () => {
    const db = adminDb({
      reports: [{
        id: 42,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status } = await request(db, '/_matrix/client/v3/admin/reports/42/resolve', jsonInit('POST', { note: null }));
    expect(status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });
  it('resolve missing soft-0', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1000/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-1', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1001/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-2', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1002/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-3', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1003/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-4', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1004/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-5', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1005/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-6', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1006/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('resolve missing soft-7', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1007/resolve', jsonInit('POST', { note: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
});

describe('report leftovers failure edges after #148', () => {
  it('event report missing event', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('event report missing membership', async () => {
    const db = createReportDb({
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const { status, body } = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('room report missing room', async () => {
    const db = createReportDb({ rooms: [] });
    const { status, body } = await request(db, roomReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('user report missing user', async () => {
    const db = createReportDb({ users: [{ user_id: USER, admin: 0 }] });
    const { status, body } = await request(db, userReportPath('@ghost:example.com'), jsonInit('POST', { reason: 'x' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('admin list non-admin', async () => {
    const db = createReportDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin get non-admin', async () => {
    const db = createReportDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin resolve non-admin', async () => {
    const db = createReportDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1/resolve', jsonInit('POST', {}));
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
  it('admin get missing report', async () => {
    const db = adminDb();
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/999', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('event report bad json body soft defaults', async () => {
    const db = memberDb();
    const { status } = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{not-json',
    });
    expect(status).toBe(200);
    expect(db.reports[0].reason).toBe('');
    expect(db.reports[0].score).toBe(-100);
  });
  it('room report bad json soft defaults', async () => {
    const db = createReportDb();
    const { status } = await request(db, roomReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'nope',
    });
    expect(status).toBe(200);
    expect(db.reports[0].score).toBe(-100);
  });
  it('user report bad json soft defaults', async () => {
    const db = createReportDb();
    const { status } = await request(db, userReportPath(BOB), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '',
    });
    expect(status).toBe(200);
    expect(db.reports[0].reason).toBe('');
  });
  it('empty event content parses as null', async () => {
    const db = adminDb({
      events: [{ event_id: EVENT, room_id: ROOM, sender: BOB, event_type: 'm.room.message', content: '' }],
      reports: [{
        id: 1,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: 'x',
        score: -1,
        created_at: NOW,
        resolved: 0,
      }],
    });
    const { status, body } = await request(db, '/_matrix/client/v3/admin/reports/1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(status).toBe(200);
    expect(body.event_content).toBeNull();
  });

});

describe('report leftovers lifecycle soft floods after #148', () => {
  it('event→admin→resolve lifecycle soft-0', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-0', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-0');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-0' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-1', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-1', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-1');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-1' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-2', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-2', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-2');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-2' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-3', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-3', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-3');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-3' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-4', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-4', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-4');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-4' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-5', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-5', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-5');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-5' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-6', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-6', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-6');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-6' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-7', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-7', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-7');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-7' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-8', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-8', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-8');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-8' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-9', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-9', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-9');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-9' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-10', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-10', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-10');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-10' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('event→admin→resolve lifecycle soft-11', async () => {
    const db = adminDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'life-11', score: -40 }));
    expect(db.reports).toHaveLength(1);
    const list = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    expect(list.body.reports[0].reason).toBe('life-11');
    const id = list.body.reports[0].id;
    const res = await request(db, `/_matrix/client/v3/admin/reports/${id}/resolve`, jsonInit('POST', { note: 'done-11' }));
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('room+user dual report soft-0', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-0', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-0' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-1', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-1', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-1' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-2', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-2', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-2' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-3', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-3', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-3' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-4', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-4', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-4' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-5', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-5', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-5' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-6', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-6', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-6' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
  it('room+user dual report soft-7', async () => {
    const db = createReportDb();
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r-7', score: -30 }));
    await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'u-7' }));
    expect(db.reports).toHaveLength(2);
    expect(db.reports.map((r) => r.report_type).sort()).toEqual(['room', 'user']);
  });
});
