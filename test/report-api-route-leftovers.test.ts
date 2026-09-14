/**
 * TOKENMAXX HEAVY leftovers after #149 — report API soft/edge/reliability.
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

              // duplicate event report
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

              // duplicate room report
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

              // duplicate user report
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

              // get specific report with event join
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

              // UPDATE event report
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

              // UPDATE room report
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

              // UPDATE user report
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

              // resolve
              if (
                sql.includes('UPDATE content_reports') &&
                sql.includes('SET resolved = 1')
              ) {
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

              // INSERT event report
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

              // INSERT room report
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

              // INSERT user report
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
): Promise<{ status: number; body: unknown; text: string }> {
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
  return { status: res.status, body, text };
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

function adminJoinedDb(extra: Parameters<typeof createReportDb>[0] = {}): ReportDb {
  return createReportDb({
    users: [
      { user_id: USER, admin: 1 },
      { user_id: BOB, admin: 0 },
    ],
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

// ---------------------------------------------------------------------------
// POST /rooms/:roomId/report/:eventId
// ---------------------------------------------------------------------------

describe('report leftovers event report soft flood after #149', () => {
  it('event report soft-0', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-0', score: -50 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-0');
  });
  it('event report soft-1', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-1', score: -51 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-1');
  });
  it('event report soft-2', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-2', score: -52 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-2');
  });
  it('event report soft-3', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-3', score: -53 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-3');
  });
  it('event report soft-4', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-4', score: -54 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-4');
  });
  it('event report soft-5', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-5', score: -55 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-5');
  });
  it('event report soft-6', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-6', score: -56 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-6');
  });
  it('event report soft-7', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-7', score: -57 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-7');
  });
  it('event report soft-8', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-8', score: -58 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-8');
  });
  it('event report soft-9', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-9', score: -59 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-9');
  });
  it('event report soft-10', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-10', score: -60 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-10');
  });
  it('event report soft-11', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-11', score: -61 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-11');
  });
  it('event report soft-12', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-12', score: -62 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-12');
  });
  it('event report soft-13', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-13', score: -63 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-13');
  });
  it('event report soft-14', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-14', score: -64 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-14');
  });
  it('event report soft-15', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'spam-15', score: -65 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('spam-15');
  });
});
describe('report leftovers room report soft flood after #149', () => {
  it('room report soft-0', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-0', score: -10 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-0')).toBe(true);
  });
  it('room report soft-1', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-1', score: -11 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-1')).toBe(true);
  });
  it('room report soft-2', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-2', score: -12 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-2')).toBe(true);
  });
  it('room report soft-3', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-3', score: -13 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-3')).toBe(true);
  });
  it('room report soft-4', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-4', score: -14 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-4')).toBe(true);
  });
  it('room report soft-5', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-5', score: -15 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-5')).toBe(true);
  });
  it('room report soft-6', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-6', score: -16 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-6')).toBe(true);
  });
  it('room report soft-7', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-7', score: -17 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-7')).toBe(true);
  });
  it('room report soft-8', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-8', score: -18 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-8')).toBe(true);
  });
  it('room report soft-9', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-9', score: -19 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-9')).toBe(true);
  });
  it('room report soft-10', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-10', score: -20 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-10')).toBe(true);
  });
  it('room report soft-11', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-11', score: -21 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-11')).toBe(true);
  });
  it('room report soft-12', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-12', score: -22 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-12')).toBe(true);
  });
  it('room report soft-13', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-13', score: -23 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-13')).toBe(true);
  });
  it('room report soft-14', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-14', score: -24 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-14')).toBe(true);
  });
  it('room report soft-15', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'room-15', score: -25 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'room-15')).toBe(true);
  });
});
describe('report leftovers user report soft flood after #149', () => {
  it('user report soft-0', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-0', score: -20 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-0')).toBe(true);
  });
  it('user report soft-1', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-1', score: -21 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-1')).toBe(true);
  });
  it('user report soft-2', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-2', score: -22 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-2')).toBe(true);
  });
  it('user report soft-3', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-3', score: -23 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-3')).toBe(true);
  });
  it('user report soft-4', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-4', score: -24 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-4')).toBe(true);
  });
  it('user report soft-5', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-5', score: -25 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-5')).toBe(true);
  });
  it('user report soft-6', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-6', score: -26 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-6')).toBe(true);
  });
  it('user report soft-7', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-7', score: -27 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-7')).toBe(true);
  });
  it('user report soft-8', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-8', score: -28 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-8')).toBe(true);
  });
  it('user report soft-9', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-9', score: -29 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-9')).toBe(true);
  });
  it('user report soft-10', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-10', score: -30 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-10')).toBe(true);
  });
  it('user report soft-11', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-11', score: -31 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-11')).toBe(true);
  });
  it('user report soft-12', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-12', score: -32 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-12')).toBe(true);
  });
  it('user report soft-13', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-13', score: -33 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-13')).toBe(true);
  });
  it('user report soft-14', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-14', score: -34 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-14')).toBe(true);
  });
  it('user report soft-15', async () => {
    const db = adminJoinedDb();
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'user-15', score: -35 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports.some((r) => r.reason === 'user-15')).toBe(true);
  });
});
describe('report leftovers admin list soft flood after #149', () => {
  it('admin list soft-0', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-0',
          score: -100,
          created_at: NOW + 0,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-1', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 2,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-1',
          score: -100,
          created_at: NOW + 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-2', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 3,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-2',
          score: -100,
          created_at: NOW + 2,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-3', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 4,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-3',
          score: -100,
          created_at: NOW + 3,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-4', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 5,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-4',
          score: -100,
          created_at: NOW + 4,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-5', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 6,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-5',
          score: -100,
          created_at: NOW + 5,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-6', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 7,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-6',
          score: -100,
          created_at: NOW + 6,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-7', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 8,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-7',
          score: -100,
          created_at: NOW + 7,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-8', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 9,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-8',
          score: -100,
          created_at: NOW + 8,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-9', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 10,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-9',
          score: -100,
          created_at: NOW + 9,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-10', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 11,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-10',
          score: -100,
          created_at: NOW + 10,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-11', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 12,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-11',
          score: -100,
          created_at: NOW + 11,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-12', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 13,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-12',
          score: -100,
          created_at: NOW + 12,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-13', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 14,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-13',
          score: -100,
          created_at: NOW + 13,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-14', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 15,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-14',
          score: -100,
          created_at: NOW + 14,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
  it('admin list soft-15', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 16,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r-15',
          score: -100,
          created_at: NOW + 15,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
  });
});
describe('report leftovers admin get soft flood after #149', () => {
  it('admin get soft-0', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 100,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-0',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/100');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-0');
  });
  it('admin get soft-1', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 101,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-1',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/101');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-1');
  });
  it('admin get soft-2', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 102,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-2',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/102');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-2');
  });
  it('admin get soft-3', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 103,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-3',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/103');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-3');
  });
  it('admin get soft-4', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 104,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-4',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/104');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-4');
  });
  it('admin get soft-5', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 105,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-5',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/105');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-5');
  });
  it('admin get soft-6', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 106,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-6',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/106');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-6');
  });
  it('admin get soft-7', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 107,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-7',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/107');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-7');
  });
  it('admin get soft-8', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 108,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-8',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/108');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-8');
  });
  it('admin get soft-9', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 109,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-9',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/109');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-9');
  });
  it('admin get soft-10', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 110,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-10',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/110');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-10');
  });
  it('admin get soft-11', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 111,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-11',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/111');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-11');
  });
  it('admin get soft-12', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 112,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-12',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/112');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-12');
  });
  it('admin get soft-13', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 113,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-13',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/113');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-13');
  });
  it('admin get soft-14', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 114,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-14',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/114');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-14');
  });
  it('admin get soft-15', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 115,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'get-15',
          score: -50,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/115');
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('get-15');
  });
});
describe('report leftovers admin resolve soft flood after #149', () => {
  it('admin resolve soft-0', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 200,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-0',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/200/resolve',
      jsonInit('POST', { note: 'ok-0' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-1', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 201,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-1',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/201/resolve',
      jsonInit('POST', { note: 'ok-1' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-2', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 202,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-2',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/202/resolve',
      jsonInit('POST', { note: 'ok-2' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-3', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 203,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-3',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/203/resolve',
      jsonInit('POST', { note: 'ok-3' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-4', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 204,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-4',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/204/resolve',
      jsonInit('POST', { note: 'ok-4' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-5', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 205,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-5',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/205/resolve',
      jsonInit('POST', { note: 'ok-5' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-6', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 206,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-6',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/206/resolve',
      jsonInit('POST', { note: 'ok-6' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-7', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 207,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-7',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/207/resolve',
      jsonInit('POST', { note: 'ok-7' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-8', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 208,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-8',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/208/resolve',
      jsonInit('POST', { note: 'ok-8' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-9', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 209,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-9',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/209/resolve',
      jsonInit('POST', { note: 'ok-9' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-10', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 210,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-10',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/210/resolve',
      jsonInit('POST', { note: 'ok-10' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-11', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 211,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-11',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/211/resolve',
      jsonInit('POST', { note: 'ok-11' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-12', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 212,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-12',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/212/resolve',
      jsonInit('POST', { note: 'ok-12' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-13', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 213,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-13',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/213/resolve',
      jsonInit('POST', { note: 'ok-13' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-14', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 214,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-14',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/214/resolve',
      jsonInit('POST', { note: 'ok-14' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('admin resolve soft-15', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 215,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'res-15',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/215/resolve',
      jsonInit('POST', { note: 'ok-15' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
});
describe('report leftovers event update soft flood after #149', () => {
  it('event report update soft-0', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-0', score: -30 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-0');
  });
  it('event report update soft-1', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-1', score: -31 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-1');
  });
  it('event report update soft-2', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-2', score: -32 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-2');
  });
  it('event report update soft-3', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-3', score: -33 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-3');
  });
  it('event report update soft-4', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-4', score: -34 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-4');
  });
  it('event report update soft-5', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-5', score: -35 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-5');
  });
  it('event report update soft-6', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-6', score: -36 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-6');
  });
  it('event report update soft-7', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-7', score: -37 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-7');
  });
  it('event report update soft-8', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-8', score: -38 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-8');
  });
  it('event report update soft-9', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-9', score: -39 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-9');
  });
  it('event report update soft-10', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-10', score: -40 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-10');
  });
  it('event report update soft-11', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-11', score: -41 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-11');
  });
  it('event report update soft-12', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-12', score: -42 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-12');
  });
  it('event report update soft-13', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-13', score: -43 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-13');
  });
  it('event report update soft-14', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-14', score: -44 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-14');
  });
  it('event report update soft-15', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'upd-15', score: -45 })
    );
    expect(res.status).toBe(200);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].reason).toBe('upd-15');
  });
});

describe('report leftovers failure and edge cases after #149', () => {
  it('event report forbids non-member', async () => {
    const db = createReportDb({
      memberships: [],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('event report forbids invite-only membership', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(res.status).toBe(403);
  });

  it('event report allows leave membership', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'left' }));
    expect(res.status).toBe(200);
  });

  it('event report 404 missing event', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('room report 404 missing room', async () => {
    const db = createReportDb({ rooms: [], memberships: [] });
    const res = await request(db, roomReportPath('!missing:example.com'), jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('user report 404 missing user', async () => {
    const db = createReportDb({ users: [{ user_id: USER, admin: 0 }] });
    const res = await request(
      db,
      userReportPath('@ghost:example.com'),
      jsonInit('POST', { reason: 'x' })
    );
    expect(res.status).toBe(404);
  });

  it('admin list forbids non-admin', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports');
    expect(res.status).toBe(403);
  });

  it('admin get forbids non-admin', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/1');
    expect(res.status).toBe(403);
  });

  it('admin get 404 missing report', async () => {
    const db = adminJoinedDb({ reports: [] });
    const res = await request(db, '/_matrix/client/v3/admin/reports/999');
    expect(res.status).toBe(404);
  });

  it('admin resolve forbids non-admin', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/1/resolve',
      jsonInit('POST', { note: 'n' })
    );
    expect(res.status).toBe(403);
  });

  it('score clamps above 0 to 0', async () => {
    const db = adminJoinedDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'x', score: 50 }));
    expect(db.reports[0].score).toBe(0);
  });

  it('score clamps below -100 to -100', async () => {
    const db = adminJoinedDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'x', score: -999 }));
    expect(db.reports[0].score).toBe(-100);
  });

  it('default score -100 when omitted', async () => {
    const db = adminJoinedDb();
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(db.reports[0].score).toBe(-100);
  });

  it('empty body still reports event', async () => {
    const db = adminJoinedDb();
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(res.status).toBe(200);
  });
});

describe('report leftovers Content-Type charset soft flood after #149', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'application/json; charset="utf-8"',
  ];
  it('event report charset soft-0', async () => {
    const db = adminJoinedDb();
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': charsets[0], Authorization: 'Bearer t' },
      body: JSON.stringify({ reason: 'ct-0', score: -10 }),
    });
    expect(res.status).toBe(200);
  });
  it('event report charset soft-1', async () => {
    const db = adminJoinedDb();
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': charsets[1], Authorization: 'Bearer t' },
      body: JSON.stringify({ reason: 'ct-1', score: -10 }),
    });
    expect(res.status).toBe(200);
  });
  it('event report charset soft-2', async () => {
    const db = adminJoinedDb();
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': charsets[2], Authorization: 'Bearer t' },
      body: JSON.stringify({ reason: 'ct-2', score: -10 }),
    });
    expect(res.status).toBe(200);
  });
  it('event report charset soft-3', async () => {
    const db = adminJoinedDb();
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': charsets[3], Authorization: 'Bearer t' },
      body: JSON.stringify({ reason: 'ct-3', score: -10 }),
    });
    expect(res.status).toBe(200);
  });
  it('event report charset soft-4', async () => {
    const db = adminJoinedDb();
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': charsets[4], Authorization: 'Bearer t' },
      body: JSON.stringify({ reason: 'ct-4', score: -10 }),
    });
    expect(res.status).toBe(200);
  });
  it('resolve charset soft-0', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 300,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/300/resolve', {
      method: 'POST',
      headers: { 'Content-Type': charsets[0], Authorization: 'Bearer t' },
      body: JSON.stringify({ note: 'n-0' }),
    });
    expect(res.status).toBe(200);
  });
  it('resolve charset soft-1', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 301,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/301/resolve', {
      method: 'POST',
      headers: { 'Content-Type': charsets[1], Authorization: 'Bearer t' },
      body: JSON.stringify({ note: 'n-1' }),
    });
    expect(res.status).toBe(200);
  });
  it('resolve charset soft-2', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 302,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/302/resolve', {
      method: 'POST',
      headers: { 'Content-Type': charsets[2], Authorization: 'Bearer t' },
      body: JSON.stringify({ note: 'n-2' }),
    });
    expect(res.status).toBe(200);
  });
  it('resolve charset soft-3', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 303,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/303/resolve', {
      method: 'POST',
      headers: { 'Content-Type': charsets[3], Authorization: 'Bearer t' },
      body: JSON.stringify({ note: 'n-3' }),
    });
    expect(res.status).toBe(200);
  });
  it('resolve charset soft-4', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 304,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'r',
          score: -100,
          created_at: NOW,
          resolved: 0,
          report_type: 'event',
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/304/resolve', {
      method: 'POST',
      headers: { 'Content-Type': charsets[4], Authorization: 'Bearer t' },
      body: JSON.stringify({ note: 'n-4' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('report leftovers method matrix after #149', () => {
  const cases: Array<{ path: string; bad: string[] }> = [
    { path: '/_matrix/client/v3/rooms/' + encodeURIComponent(ROOM) + '/report/' + encodeURIComponent(EVENT), bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/rooms/' + encodeURIComponent(ROOM) + '/report', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/users/' + encodeURIComponent(BOB) + '/report', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/admin/reports', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/admin/reports/1', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path}`, async () => {
        const db = adminJoinedDb({
          reports: [
            {
              id: 1,
              reporter_user_id: USER,
              room_id: ROOM,
              event_id: EVENT,
              reason: 'r',
              score: -100,
              created_at: NOW,
              resolved: 0,
              report_type: 'event',
            },
          ],
        });
        const res = await request(db, c.path, jsonInit(method, method === 'GET' ? undefined : {}));
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});
describe('report leftovers lifecycle soft floods after #149', () => {
  it('report→list→get→resolve lifecycle soft-0', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-0', score: -40 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-0');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-0' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-1', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-1', score: -41 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-1');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-1' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-2', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-2', score: -42 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-2');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-2' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-3', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-3', score: -43 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-3');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-3' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-4', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-4', score: -44 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-4');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-4' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-5', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-5', score: -45 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-5');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-5' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-6', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-6', score: -46 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-6');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-6' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-7', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-7', score: -47 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-7');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-7' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-8', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-8', score: -48 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-8');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-8' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-9', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-9', score: -49 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-9');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-9' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-10', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-10', score: -50 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-10');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-10' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-11', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-11', score: -51 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-11');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-11' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-12', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-12', score: -52 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-12');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-12' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-13', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-13', score: -53 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-13');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-13' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-14', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-14', score: -54 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-14');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-14' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
  it('report→list→get→resolve lifecycle soft-15', async () => {
    const db = adminJoinedDb();
    const reported = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'life-15', score: -55 })
    );
    expect(reported.status).toBe(200);
    const id = db.reports[0].id;

    const list = await request(db, '/_matrix/client/v3/admin/reports');
    expect(list.status).toBe(200);
    expect(list.body.reports.some((r: { id: number }) => r.id === id)).toBe(true);

    const get = await request(db, `/_matrix/client/v3/admin/reports/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.reason).toBe('life-15');

    const resolved = await request(
      db,
      `/_matrix/client/v3/admin/reports/${id}/resolve`,
      jsonInit('POST', { note: 'done-15' })
    );
    expect(resolved.status).toBe(200);
    expect(db.reports[0].resolved).toBe(1);
  });
});
