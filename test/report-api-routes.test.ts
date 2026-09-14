/**
 * TOKENMAXX HEAVY deepen — content reporting API routes (ALL of src/api/report.ts).
 * Tests-only — no product inventing.
 * Exercises event/room/user report CRUD, score clamp, membership gates,
 * and admin list/get/resolve with admin flag on users table.
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
const REMOTE = 'remote.example.org';
const EVENT = '$evt:example.com';
const BOB_ENC = encodeURIComponent(BOB);

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

describe('report POST /rooms/:roomId/report/:eventId', () => {
  it('forbids when membership missing', async () => {
    const db = createReportDb({
      memberships: [],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'spam' }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
    expect(db.inserts).toHaveLength(0);
  });

  it('forbids ban membership', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('forbids knock membership', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('forbids invite membership', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { score: -50 }));
    expect(res.status).toBe(403);
  });

  it('allows join membership and creates new report', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'abuse', score: -40 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, EVENT, 'abuse', -40, NOW]);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({
      reporter_user_id: USER,
      room_id: ROOM,
      event_id: EVENT,
      reason: 'abuse',
      score: -40,
      resolved: 0,
    });
  });

  it('allows leave membership', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'left-ok' }));
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
  });

  it('returns 404 when event missing', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { reason: 'x' }));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Event not found' });
  });

  it('returns 404 when event exists in different room', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: '!other:example.com' }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('updates duplicate report instead of inserting', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
      reports: [
        {
          id: 7,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'old',
          score: -10,
          created_at: NOW - 1000,
          resolved: 0,
        },
      ],
    });
    const res = await request(
      db,
      eventReportPath(),
      jsonInit('POST', { reason: 'updated', score: -90 })
    );
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({
      id: 7,
      reason: 'updated',
      score: -90,
      created_at: NOW,
    });
  });

  it('clamps score above 0 down to 0', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { score: 50 }));
    expect(res.status).toBe(200);
    expect(db.inserts[0].args[4]).toBe(0);
  });

  it('clamps score below -100 up to -100', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', { score: -999 }));
    expect(res.status).toBe(200);
    expect(db.inserts[0].args[4]).toBe(-100);
  });

  it('preserves in-range score -50', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    await request(db, eventReportPath(), jsonInit('POST', { score: -50 }));
    expect(db.inserts[0].args[4]).toBe(-50);
  });

  it('defaults score to -100 when omitted', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    await request(db, eventReportPath(), jsonInit('POST', { reason: 'no-score' }));
    expect(db.inserts[0].args[4]).toBe(-100);
  });

  it('defaults score to -100 when score is non-number string', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    await request(db, eventReportPath(), jsonInit('POST', { score: '-40' }));
    expect(db.inserts[0].args[4]).toBe(-100);
  });

  it('accepts empty body (bad JSON → {}) with default reason/score', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: '{',
    });
    expect(res.status).toBe(200);
    expect(db.inserts[0].args).toEqual([USER, ROOM, EVENT, '', -100, NOW]);
  });

  it('accepts empty JSON object body', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    const res = await request(db, eventReportPath(), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(db.inserts[0].args[3]).toBe('');
    expect(db.inserts[0].args[4]).toBe(-100);
  });

  it('defaults missing reason to empty string', async () => {
    const db = createReportDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [{ event_id: EVENT, room_id: ROOM }],
    });
    await request(db, eventReportPath(), jsonInit('POST', { score: -1 }));
    expect(db.inserts[0].args[3]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// POST /rooms/:roomId/report
// ---------------------------------------------------------------------------

describe('report POST /rooms/:roomId/report', () => {
  it('returns 404 when room missing', async () => {
    const db = createReportDb({ rooms: [] });
    const res = await request(db, roomReportPath(), jsonInit('POST', { reason: 'bad room' }));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Room not found' });
  });

  it('creates new room report with event_id NULL and report_type room', async () => {
    const db = createReportDb({ rooms: [ROOM] });
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'toxic', score: -70 })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, 'toxic', -70, NOW]);
    expect(db.reports[0]).toMatchObject({
      room_id: ROOM,
      event_id: null,
      report_type: 'room',
      reason: 'toxic',
      score: -70,
    });
  });

  it('updates existing room report on duplicate', async () => {
    const db = createReportDb({
      rooms: [ROOM],
      reports: [
        {
          id: 3,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: null,
          reason: 'old',
          score: -20,
          created_at: NOW - 5,
          resolved: 0,
          report_type: 'room',
        },
      ],
    });
    const res = await request(
      db,
      roomReportPath(),
      jsonInit('POST', { reason: 'new', score: -80 })
    );
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({
      id: 3,
      reason: 'new',
      score: -80,
      created_at: NOW,
    });
  });

  it('clamps room report score to [-100, 0]', async () => {
    const db = createReportDb({ rooms: [ROOM] });
    await request(db, roomReportPath(), jsonInit('POST', { score: 10 }));
    expect(db.inserts[0].args[3]).toBe(0);

    const db2 = createReportDb({ rooms: [ROOM] });
    await request(db2, roomReportPath(), jsonInit('POST', { score: -150 }));
    expect(db2.inserts[0].args[3]).toBe(-100);
  });

  it('defaults room report score to -100', async () => {
    const db = createReportDb({ rooms: [ROOM] });
    await request(db, roomReportPath(), jsonInit('POST', { reason: 'r' }));
    expect(db.inserts[0].args[3]).toBe(-100);
  });

  it('accepts bad JSON body as empty for room report', async () => {
    const db = createReportDb({ rooms: [ROOM] });
    const res = await request(db, roomReportPath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'not-json',
    });
    expect(res.status).toBe(200);
    expect(db.inserts[0].args).toEqual([USER, ROOM, '', -100, NOW]);
  });

  it('does not treat event report as duplicate of room report', async () => {
    const db = createReportDb({
      rooms: [ROOM],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'evt',
          score: -100,
          created_at: NOW - 1,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, roomReportPath(), jsonInit('POST', { reason: 'room' }));
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(db.reports).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// POST /users/:reportedUserId/report
// ---------------------------------------------------------------------------

describe('report POST /users/:id/report', () => {
  it('returns 404 when reported user missing', async () => {
    const db = createReportDb({ users: [{ user_id: USER, admin: 0 }] });
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'harassment' })
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'User not found' });
  });

  it('creates new user report', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
    });
    const res = await request(
      db,
      userReportPath(BOB),
      jsonInit('POST', { reason: 'spam bot' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, 'spam bot', NOW, BOB]);
    expect(db.reports[0]).toMatchObject({
      report_type: 'user',
      reported_user_id: BOB,
      room_id: null,
      event_id: null,
      score: -100,
      reason: 'spam bot',
    });
  });

  it('updates existing user report on duplicate', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
      reports: [
        {
          id: 9,
          reporter_user_id: USER,
          room_id: null,
          event_id: null,
          reason: 'old',
          score: -100,
          created_at: NOW - 9,
          resolved: 0,
          report_type: 'user',
          reported_user_id: BOB,
        },
      ],
    });
    const res = await request(db, userReportPath(BOB), jsonInit('POST', { reason: 'new' }));
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(0);
    expect(db.updates).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({ reason: 'new', created_at: NOW, id: 9 });
  });

  it('decodes URI-encoded user id', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/users/${BOB_ENC}/report`,
      jsonInit('POST', { reason: 'enc' })
    );
    expect(res.status).toBe(200);
    expect(db.inserts[0].args[3]).toBe(BOB);
  });

  it('defaults empty reason when body empty / bad JSON', async () => {
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: BOB, admin: 0 },
      ],
    });
    const res = await request(db, userReportPath(BOB), {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(200);
    expect(db.inserts[0].args[1]).toBe('');
  });

  it('can report remote-looking local user id string', async () => {
    const remoteUser = `@evil:${REMOTE}`;
    const db = createReportDb({
      users: [
        { user_id: USER, admin: 0 },
        { user_id: remoteUser, admin: 0 },
      ],
    });
    const res = await request(
      db,
      userReportPath(remoteUser),
      jsonInit('POST', { reason: 'federated spam' })
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].reported_user_id).toBe(remoteUser);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/reports
// ---------------------------------------------------------------------------

describe('report GET /admin/reports', () => {
  it('forbids non-admin (admin=0)', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Admin access required',
    });
  });

  it('forbids when user row missing', async () => {
    const db = createReportDb({ users: [] });
    const res = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });

  it('lists reports for admin with parsed event content', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 5,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'bad',
          score: -100,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      reports: Array<Record<string, unknown>>;
      next_token?: string;
    };
    expect(body.reports).toHaveLength(1);
    expect(body.next_token).toBeUndefined();
    expect(body.reports[0]).toMatchObject({
      id: 5,
      reporter_user_id: USER,
      reported_user_id: BOB,
      room_id: ROOM,
      event_id: EVENT,
      event_type: 'm.room.message',
      event_content: { body: 'hi', msgtype: 'm.text' },
      reason: 'bad',
      score: -100,
      created_at: NOW,
      resolved: false,
    });
  });

  it('filters resolved=true', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'a',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
        {
          id: 2,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'b',
          score: -2,
          created_at: NOW - 1,
          resolved: 1,
          resolved_by: USER,
          resolved_at: NOW - 1,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports?resolved=true', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { reports: Array<{ id: number; resolved: boolean }> };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].id).toBe(2);
    expect(body.reports[0].resolved).toBe(true);
  });

  it('filters resolved=false', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'a',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
        {
          id: 2,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'b',
          score: -2,
          created_at: NOW - 1,
          resolved: 1,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports?resolved=false', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { reports: Array<{ id: number }> };
    expect(body.reports.map((r) => r.id)).toEqual([1]);
  });

  it('paginates with from and returns next_token when more remain', async () => {
    const reports: ReportRow[] = [];
    for (let i = 10; i >= 1; i--) {
      reports.push({
        id: i,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: `r${i}`,
        score: -100,
        created_at: NOW - (10 - i),
        resolved: 0,
      });
    }
    const db = adminJoinedDb({ reports });

    const res = await request(db, '/_matrix/client/v3/admin/reports?limit=3', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      reports: Array<{ id: number }>;
      next_token?: string;
    };
    expect(body.reports).toHaveLength(3);
    expect(body.next_token).toBe(String(body.reports[2].id));

    const page2 = await request(
      db,
      `/_matrix/client/v3/admin/reports?limit=3&from=${body.next_token}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    const body2 = page2.body as {
      reports: Array<{ id: number }>;
      next_token?: string;
    };
    expect(body2.reports).toHaveLength(3);
    expect(body2.reports.every((r) => r.id < Number(body.next_token))).toBe(true);
  });

  it('caps limit at 100 (requests 101 → fetch 102 then slice 100)', async () => {
    const reports: ReportRow[] = [];
    for (let i = 1; i <= 105; i++) {
      reports.push({
        id: i,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: `r${i}`,
        score: -1,
        created_at: NOW - i,
        resolved: 0,
      });
    }
    const db = adminJoinedDb({ reports });
    const res = await request(db, '/_matrix/client/v3/admin/reports?limit=999', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      reports: unknown[];
      next_token?: string;
    };
    expect(body.reports).toHaveLength(100);
    expect(body.next_token).toBeDefined();

    // Verify the SQL bind used capped limit+1 (=101)
    const listCall = db.selects.find((s) => s.sql.includes('WHERE 1=1'));
    expect(listCall?.args[listCall.args.length - 1]).toBe(101);
  });

  it('defaults limit to 50 when omitted', async () => {
    const reports: ReportRow[] = [];
    for (let i = 1; i <= 55; i++) {
      reports.push({
        id: i,
        reporter_user_id: USER,
        room_id: ROOM,
        event_id: EVENT,
        reason: `r${i}`,
        score: -1,
        created_at: NOW - i,
        resolved: 0,
      });
    }
    const db = adminJoinedDb({ reports });
    const res = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { reports: unknown[]; next_token?: string };
    expect(body.reports).toHaveLength(50);
    expect(body.next_token).toBeDefined();
    const listCall = db.selects.find((s) => s.sql.includes('WHERE 1=1'));
    expect(listCall?.args[0]).toBe(51);
  });

  it('returns null event_content when content missing/empty (falsy)', async () => {
    const db = adminJoinedDb({
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: null,
        },
      ],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -100,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { reports: Array<{ event_content: unknown }> };
    expect(body.reports[0].event_content).toBeNull();
  });

  it('returns null event_content when content is empty string', async () => {
    const db = adminJoinedDb({
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: '',
        },
      ],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -100,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { reports: Array<{ event_content: unknown }> };
    expect(body.reports[0].event_content).toBeNull();
  });

  it('omits next_token when results fit in page', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'only',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports?limit=10', {
      headers: { Authorization: 'Bearer t' },
    });
    expect((res.body as { next_token?: string }).next_token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /admin/reports/:reportId
// ---------------------------------------------------------------------------

describe('report GET /admin/reports/:id', () => {
  it('forbids non-admin', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/1', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Admin access required' });
  });

  it('returns 404 when report not found', async () => {
    const db = adminJoinedDb({ reports: [] });
    const res = await request(db, '/_matrix/client/v3/admin/reports/99', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Report not found' });
  });

  it('returns report with parsed event content', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 42,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'detail',
          score: -55,
          created_at: NOW - 3,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/42', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 42,
      reporter_user_id: USER,
      reported_user_id: BOB,
      room_id: ROOM,
      event_id: EVENT,
      event_type: 'm.room.message',
      event_content: { body: 'hi', msgtype: 'm.text' },
      reason: 'detail',
      score: -55,
      created_at: NOW - 3,
      resolved: false,
    });
  });

  it('returns null event_content when event content absent', async () => {
    const db = adminJoinedDb({
      events: [
        {
          event_id: EVENT,
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          content: null,
        },
      ],
      reports: [
        {
          id: 2,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/2', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { event_content: unknown }).event_content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /admin/reports/:reportId/resolve
// ---------------------------------------------------------------------------

describe('report POST /admin/reports/:id/resolve', () => {
  it('forbids non-admin', async () => {
    const db = createReportDb({
      users: [{ user_id: USER, admin: 0 }],
      reports: [
        {
          id: 1,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/1/resolve',
      jsonInit('POST', { note: 'done' })
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when changes=0 (report missing)', async () => {
    const db = adminJoinedDb({ reports: [] });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/123/resolve',
      jsonInit('POST', { note: 'n/a' })
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Report not found' });
  });

  it('resolves successfully with note', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 8,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/8/resolve',
      jsonInit('POST', { note: 'action taken' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.reports[0]).toMatchObject({
      resolved: 1,
      resolved_by: USER,
      resolved_at: NOW,
      resolution_note: 'action taken',
    });
  });

  it('resolves successfully without note (null)', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 8,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/admin/reports/8/resolve',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(db.reports[0].resolution_note).toBeNull();
    expect(db.reports[0].resolved).toBe(1);
    expect(db.reports[0].resolved_by).toBe(USER);
  });

  it('treats bad JSON body as {} and resolves with null note', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 4,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    const res = await request(db, '/_matrix/client/v3/admin/reports/4/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(200);
    expect(db.reports[0].resolution_note).toBeNull();
    expect(db.updates[0].args).toEqual([USER, NOW, null, 4]);
  });

  it('empty note string becomes null via note || null', async () => {
    const db = adminJoinedDb({
      reports: [
        {
          id: 4,
          reporter_user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          reason: 'x',
          score: -1,
          created_at: NOW,
          resolved: 0,
        },
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/admin/reports/4/resolve',
      jsonInit('POST', { note: '' })
    );
    expect(db.reports[0].resolution_note).toBeNull();
  });
});
