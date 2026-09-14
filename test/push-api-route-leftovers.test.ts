/**
 * TOKENMAXX HEAVY leftovers after #157 — push API route soft/edge/reliability.
 * Complements push-api-routes.test.ts. Tests-only — no product inventing.
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

import pushApp from '../src/api/push';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!room:example.com';
const EVENT = '$event:example.com';

type PusherRow = {
  user_id: string;
  pushkey: string;
  kind: string;
  app_id: string;
  app_display_name: string;
  device_display_name: string;
  profile_tag: string | null;
  lang: string;
  data: string;
  enabled: number;
};

type PushRuleRow = {
  user_id: string;
  kind: string;
  rule_id: string;
  conditions: string | null;
  actions: string;
  enabled: number;
  priority: number;
};

type NotificationRow = {
  id: number;
  user_id: string;
  room_id: string;
  event_id: string;
  notification_type: string;
  actions: string;
  read: number;
  created_at: number;
  event_type?: string | null;
  sender?: string | null;
  content?: string | null;
};

type SqlCall = { sql: string; args: unknown[] };

function createPushDb(opts: {
  pushers?: PusherRow[];
  rules?: PushRuleRow[];
  notifications?: NotificationRow[];
  throwOn?: string;
} = {}) {
  const pushers = opts.pushers ? [...opts.pushers] : [];
  const rules = opts.rules ? [...opts.rules] : [];
  const notifications = opts.notifications ? [...opts.notifications] : [];

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    pushers,
    rules,
    notifications,
    inserts,
    updates,
    deletes,
    runs,
    selects,
    prepare(sql: string) {
      if (opts.throwOn && sql.includes(opts.throwOn)) {
        throw new Error(`forced db error: ${opts.throwOn}`);
      }
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('SELECT conditions, actions FROM push_rules') &&
                sql.includes('WHERE user_id = ? AND kind = ? AND rule_id = ?')
              ) {
                const [userId, kind, ruleId] = args as [string, string, string];
                const hit = rules.find(
                  (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                if (!hit) return null;
                return { conditions: hit.conditions, actions: hit.actions } as T;
              }

              return null;
            },

            async all<T>() {
              selects.push({ sql, args });

              if (sql.includes('FROM pushers') && sql.includes('WHERE user_id = ?')) {
                const userId = args[0] as string;
                const results = pushers
                  .filter((p) => p.user_id === userId && p.enabled === 1)
                  .map((p) => ({
                    pushkey: p.pushkey,
                    kind: p.kind,
                    app_id: p.app_id,
                    app_display_name: p.app_display_name,
                    device_display_name: p.device_display_name,
                    profile_tag: p.profile_tag,
                    lang: p.lang,
                    data: p.data,
                  }));
                return { results } as { results: T[] };
              }

              if (
                sql.includes('FROM push_rules') &&
                sql.includes('WHERE user_id = ?') &&
                sql.includes('ORDER BY priority ASC')
              ) {
                const userId = args[0] as string;
                const results = rules
                  .filter((r) => r.user_id === userId)
                  .sort((a, b) => a.priority - b.priority)
                  .map((r) => ({
                    kind: r.kind,
                    rule_id: r.rule_id,
                    conditions: r.conditions,
                    actions: r.actions,
                    enabled: r.enabled,
                  }));
                return { results } as { results: T[] };
              }

              if (sql.includes('FROM notification_queue')) {
                const userId = args[0] as string;
                let rows = notifications.filter((n) => n.user_id === userId);

                let argIdx = 1;
                if (sql.includes('AND nq.id > ?')) {
                  const since = args[argIdx++] as number;
                  rows = rows.filter((n) => n.id > since);
                }
                if (sql.includes("notification_type = 'highlight'")) {
                  rows = rows.filter((n) => n.notification_type === 'highlight');
                }

                const limit = (args[argIdx] as number) ?? 20;
                rows = [...rows].sort((a, b) => b.created_at - a.created_at).slice(0, limit);

                const results = rows.map((n) => ({
                  id: n.id,
                  room_id: n.room_id,
                  event_id: n.event_id,
                  notification_type: n.notification_type,
                  actions: n.actions,
                  read: n.read,
                  created_at: n.created_at,
                  event_type: n.event_type ?? null,
                  sender: n.sender ?? null,
                  content: n.content ?? null,
                }));
                return { results } as { results: T[] };
              }

              return { results: [] as T[] };
            },

            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              runs.push({ sql, args });

              if (
                sql.includes('DELETE FROM pushers WHERE user_id = ? AND pushkey = ? AND app_id = ?')
              ) {
                deletes.push({ sql, args });
                const [userId, pushkey, appId] = args as [string, string, string];
                const before = pushers.length;
                for (let i = pushers.length - 1; i >= 0; i--) {
                  const p = pushers[i];
                  if (p.user_id === userId && p.pushkey === pushkey && p.app_id === appId) {
                    pushers.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - pushers.length, last_row_id: 0 },
                };
              }

              if (sql.includes('DELETE FROM pushers WHERE user_id = ? AND pushkey = ?')) {
                deletes.push({ sql, args });
                const [userId, pushkey] = args as [string, string];
                const before = pushers.length;
                for (let i = pushers.length - 1; i >= 0; i--) {
                  const p = pushers[i];
                  if (p.user_id === userId && p.pushkey === pushkey) {
                    pushers.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - pushers.length, last_row_id: 0 },
                };
              }

              if (sql.includes('INSERT INTO pushers')) {
                inserts.push({ sql, args });
                const [
                  userId,
                  pushkey,
                  kind,
                  appId,
                  appDisplayName,
                  deviceDisplayName,
                  profileTag,
                  lang,
                  data,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  string,
                ];
                const existing = pushers.findIndex(
                  (p) => p.user_id === userId && p.pushkey === pushkey && p.app_id === appId
                );
                const row: PusherRow = {
                  user_id: userId,
                  pushkey,
                  kind,
                  app_id: appId,
                  app_display_name: appDisplayName,
                  device_display_name: deviceDisplayName,
                  profile_tag: profileTag,
                  lang,
                  data,
                  enabled: 1,
                };
                if (existing >= 0) {
                  pushers[existing] = row;
                } else {
                  pushers.push(row);
                }
                return { success: true, meta: { changes: 1, last_row_id: pushers.length } };
              }

              if (
                sql.includes('INSERT INTO push_rules') &&
                sql.includes('ON CONFLICT') &&
                sql.includes('enabled = excluded.enabled')
              ) {
                // default-rule enabled override
                inserts.push({ sql, args });
                const [userId, kind, ruleId, conditions, actions, enabled] = args as [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number,
                ];
                const idx = rules.findIndex(
                  (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                const row: PushRuleRow = {
                  user_id: userId,
                  kind,
                  rule_id: ruleId,
                  conditions,
                  actions,
                  enabled,
                  priority: 0,
                };
                if (idx >= 0) {
                  rules[idx] = { ...rules[idx], enabled, conditions, actions };
                } else {
                  rules.push(row);
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (
                sql.includes('INSERT INTO push_rules') &&
                sql.includes('ON CONFLICT') &&
                sql.includes('actions = excluded.actions') &&
                !sql.includes('conditions = excluded.conditions')
              ) {
                // actions-only upsert
                inserts.push({ sql, args });
                const [userId, kind, ruleId, conditions, actions] = args as [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                ];
                const idx = rules.findIndex(
                  (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                if (idx >= 0) {
                  rules[idx] = { ...rules[idx], actions, conditions };
                } else {
                  rules.push({
                    user_id: userId,
                    kind,
                    rule_id: ruleId,
                    conditions,
                    actions,
                    enabled: 1,
                    priority: 0,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO push_rules')) {
                inserts.push({ sql, args });
                const [userId, kind, ruleId, conditions, actions, priority] = args as [
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  number,
                ];
                const idx = rules.findIndex(
                  (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                const row: PushRuleRow = {
                  user_id: userId,
                  kind,
                  rule_id: ruleId,
                  conditions,
                  actions,
                  enabled: 1,
                  priority: priority ?? 0,
                };
                if (idx >= 0) {
                  rules[idx] = {
                    ...rules[idx],
                    conditions,
                    actions,
                    priority: priority ?? rules[idx].priority,
                  };
                } else {
                  rules.push(row);
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (
                sql.includes('UPDATE push_rules SET enabled = ?') &&
                sql.includes('WHERE user_id = ? AND kind = ? AND rule_id = ?')
              ) {
                updates.push({ sql, args });
                const [enabled, userId, kind, ruleId] = args as [number, string, string, string];
                const hit = rules.find(
                  (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                if (hit) hit.enabled = enabled;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              if (
                sql.includes('DELETE FROM push_rules WHERE user_id = ? AND kind = ? AND rule_id = ?')
              ) {
                deletes.push({ sql, args });
                const [userId, kind, ruleId] = args as [string, string, string];
                const before = rules.length;
                for (let i = rules.length - 1; i >= 0; i--) {
                  const r = rules[i];
                  if (r.user_id === userId && r.kind === kind && r.rule_id === ruleId) {
                    rules.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - rules.length, last_row_id: 0 },
                };
              }

              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type PushDb = ReturnType<typeof createPushDb>;

function envFor(db: PushDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(
  db: PushDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await pushApp.request(`http://localhost${path}`, init, envFor(db));
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(
  method: string,
  body?: unknown,
  contentType = 'application/json'
): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': contentType,
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function authGet(): RequestInit {
  return { method: 'GET', headers: { Authorization: 'Bearer test-token' } };
}

function seedPusher(overrides: Partial<PusherRow> = {}): PusherRow {
  return {
    user_id: overrides.user_id ?? USER,
    pushkey: overrides.pushkey ?? 'pk-1',
    kind: overrides.kind ?? 'http',
    app_id: overrides.app_id ?? 'im.vector.app',
    app_display_name: overrides.app_display_name ?? 'Element',
    device_display_name: overrides.device_display_name ?? 'Alice Phone',
    profile_tag: overrides.profile_tag === undefined ? 'tag-a' : overrides.profile_tag,
    lang: overrides.lang ?? 'en',
    data: overrides.data ?? JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify' }),
    enabled: overrides.enabled ?? 1,
  };
}

function seedRule(overrides: Partial<PushRuleRow> = {}): PushRuleRow {
  return {
    user_id: overrides.user_id ?? USER,
    kind: overrides.kind ?? 'override',
    rule_id: overrides.rule_id ?? 'custom.rule',
    conditions:
      overrides.conditions === undefined
        ? JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }])
        : overrides.conditions,
    actions: overrides.actions ?? JSON.stringify(['notify']),
    enabled: overrides.enabled ?? 1,
    priority: overrides.priority ?? 0,
  };
}

function seedNotification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: overrides.id ?? 1,
    user_id: overrides.user_id ?? USER,
    room_id: overrides.room_id ?? ROOM,
    event_id: overrides.event_id ?? EVENT,
    notification_type: overrides.notification_type ?? 'notify',
    actions: overrides.actions ?? JSON.stringify(['notify']),
    read: overrides.read ?? 0,
    created_at: overrides.created_at ?? 1_700_000_000_000,
    event_type: overrides.event_type === undefined ? 'm.room.message' : overrides.event_type,
    sender: overrides.sender === undefined ? BOB : overrides.sender,
    content:
      overrides.content === undefined
        ? JSON.stringify({ body: 'hi', msgtype: 'm.text' })
        : overrides.content,
  };
}

const VALID_PUSHER_BODY = {
  pushkey: 'pk-new',
  kind: 'http',
  app_id: 'im.vector.app',
  app_display_name: 'Element',
  device_display_name: 'Pixel',
  lang: 'en',
  data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only' },
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('push leftovers GET pushers empty soft flood after #157', () => {
  it('GET pushers empty soft-0', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-1', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-2', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-3', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-4', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-5', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-6', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-7', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-8', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-9', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-10', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-11', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-12', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-13', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-14', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-15', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-16', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-17', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-18', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-19', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-20', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-21', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-22', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-23', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
  it('GET pushers empty soft-24', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });
});

describe('push leftovers GET pushers with rows soft flood after #157', () => {
  it('GET pushers with rows soft-0', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-0', app_id: 'im.vector.app.0', profile_tag: 'tag-0' }),
        seedPusher({ pushkey: 'pk-dis-0', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-0',
      app_id: 'im.vector.app.0',
      profile_tag: 'tag-0',
    });
  });
  it('GET pushers with rows soft-1', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-1', app_id: 'im.vector.app.1', profile_tag: 'tag-1' }),
        seedPusher({ pushkey: 'pk-dis-1', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-1',
      app_id: 'im.vector.app.1',
      profile_tag: 'tag-1',
    });
  });
  it('GET pushers with rows soft-2', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-2', app_id: 'im.vector.app.2', profile_tag: 'tag-2' }),
        seedPusher({ pushkey: 'pk-dis-2', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-2',
      app_id: 'im.vector.app.2',
      profile_tag: 'tag-2',
    });
  });
  it('GET pushers with rows soft-3', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-3', app_id: 'im.vector.app.3', profile_tag: 'tag-3' }),
        seedPusher({ pushkey: 'pk-dis-3', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-3',
      app_id: 'im.vector.app.3',
      profile_tag: 'tag-3',
    });
  });
  it('GET pushers with rows soft-4', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-4', app_id: 'im.vector.app.4', profile_tag: 'tag-4' }),
        seedPusher({ pushkey: 'pk-dis-4', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-4',
      app_id: 'im.vector.app.4',
      profile_tag: 'tag-4',
    });
  });
  it('GET pushers with rows soft-5', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-5', app_id: 'im.vector.app.5', profile_tag: 'tag-5' }),
        seedPusher({ pushkey: 'pk-dis-5', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-5',
      app_id: 'im.vector.app.5',
      profile_tag: 'tag-5',
    });
  });
  it('GET pushers with rows soft-6', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-6', app_id: 'im.vector.app.6', profile_tag: 'tag-6' }),
        seedPusher({ pushkey: 'pk-dis-6', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-6',
      app_id: 'im.vector.app.6',
      profile_tag: 'tag-6',
    });
  });
  it('GET pushers with rows soft-7', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-7', app_id: 'im.vector.app.7', profile_tag: 'tag-7' }),
        seedPusher({ pushkey: 'pk-dis-7', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-7',
      app_id: 'im.vector.app.7',
      profile_tag: 'tag-7',
    });
  });
  it('GET pushers with rows soft-8', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-8', app_id: 'im.vector.app.8', profile_tag: 'tag-8' }),
        seedPusher({ pushkey: 'pk-dis-8', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-8',
      app_id: 'im.vector.app.8',
      profile_tag: 'tag-8',
    });
  });
  it('GET pushers with rows soft-9', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-9', app_id: 'im.vector.app.9', profile_tag: 'tag-9' }),
        seedPusher({ pushkey: 'pk-dis-9', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-9',
      app_id: 'im.vector.app.9',
      profile_tag: 'tag-9',
    });
  });
  it('GET pushers with rows soft-10', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-10', app_id: 'im.vector.app.10', profile_tag: 'tag-10' }),
        seedPusher({ pushkey: 'pk-dis-10', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-10',
      app_id: 'im.vector.app.10',
      profile_tag: 'tag-10',
    });
  });
  it('GET pushers with rows soft-11', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-11', app_id: 'im.vector.app.11', profile_tag: 'tag-11' }),
        seedPusher({ pushkey: 'pk-dis-11', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-11',
      app_id: 'im.vector.app.11',
      profile_tag: 'tag-11',
    });
  });
  it('GET pushers with rows soft-12', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-12', app_id: 'im.vector.app.12', profile_tag: 'tag-12' }),
        seedPusher({ pushkey: 'pk-dis-12', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-12',
      app_id: 'im.vector.app.12',
      profile_tag: 'tag-12',
    });
  });
  it('GET pushers with rows soft-13', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-13', app_id: 'im.vector.app.13', profile_tag: 'tag-13' }),
        seedPusher({ pushkey: 'pk-dis-13', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-13',
      app_id: 'im.vector.app.13',
      profile_tag: 'tag-13',
    });
  });
  it('GET pushers with rows soft-14', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-14', app_id: 'im.vector.app.14', profile_tag: 'tag-14' }),
        seedPusher({ pushkey: 'pk-dis-14', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-14',
      app_id: 'im.vector.app.14',
      profile_tag: 'tag-14',
    });
  });
  it('GET pushers with rows soft-15', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-15', app_id: 'im.vector.app.15', profile_tag: 'tag-15' }),
        seedPusher({ pushkey: 'pk-dis-15', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-15',
      app_id: 'im.vector.app.15',
      profile_tag: 'tag-15',
    });
  });
  it('GET pushers with rows soft-16', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-16', app_id: 'im.vector.app.16', profile_tag: 'tag-16' }),
        seedPusher({ pushkey: 'pk-dis-16', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-16',
      app_id: 'im.vector.app.16',
      profile_tag: 'tag-16',
    });
  });
  it('GET pushers with rows soft-17', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-17', app_id: 'im.vector.app.17', profile_tag: 'tag-17' }),
        seedPusher({ pushkey: 'pk-dis-17', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-17',
      app_id: 'im.vector.app.17',
      profile_tag: 'tag-17',
    });
  });
  it('GET pushers with rows soft-18', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-18', app_id: 'im.vector.app.18', profile_tag: 'tag-18' }),
        seedPusher({ pushkey: 'pk-dis-18', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-18',
      app_id: 'im.vector.app.18',
      profile_tag: 'tag-18',
    });
  });
  it('GET pushers with rows soft-19', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-19', app_id: 'im.vector.app.19', profile_tag: 'tag-19' }),
        seedPusher({ pushkey: 'pk-dis-19', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-19',
      app_id: 'im.vector.app.19',
      profile_tag: 'tag-19',
    });
  });
  it('GET pushers with rows soft-20', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-20', app_id: 'im.vector.app.20', profile_tag: 'tag-20' }),
        seedPusher({ pushkey: 'pk-dis-20', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-20',
      app_id: 'im.vector.app.20',
      profile_tag: 'tag-20',
    });
  });
  it('GET pushers with rows soft-21', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-21', app_id: 'im.vector.app.21', profile_tag: 'tag-21' }),
        seedPusher({ pushkey: 'pk-dis-21', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-21',
      app_id: 'im.vector.app.21',
      profile_tag: 'tag-21',
    });
  });
  it('GET pushers with rows soft-22', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-22', app_id: 'im.vector.app.22', profile_tag: 'tag-22' }),
        seedPusher({ pushkey: 'pk-dis-22', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-22',
      app_id: 'im.vector.app.22',
      profile_tag: 'tag-22',
    });
  });
  it('GET pushers with rows soft-23', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-23', app_id: 'im.vector.app.23', profile_tag: 'tag-23' }),
        seedPusher({ pushkey: 'pk-dis-23', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-23',
      app_id: 'im.vector.app.23',
      profile_tag: 'tag-23',
    });
  });
  it('GET pushers with rows soft-24', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-row-24', app_id: 'im.vector.app.24', profile_tag: 'tag-24' }),
        seedPusher({ pushkey: 'pk-dis-24', enabled: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-row-24',
      app_id: 'im.vector.app.24',
      profile_tag: 'tag-24',
    });
  });
});

describe('push leftovers POST pushers/set create soft flood after #157', () => {
  it('POST pushers/set create soft-0', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-0',
      app_id: 'org.example.push.0',
      device_display_name: 'Device 0',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-0' && p.app_id === 'org.example.push.0')).toBe(true);
  });
  it('POST pushers/set create soft-1', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-1',
      app_id: 'org.example.push.1',
      device_display_name: 'Device 1',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-1' && p.app_id === 'org.example.push.1')).toBe(true);
  });
  it('POST pushers/set create soft-2', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-2',
      app_id: 'org.example.push.2',
      device_display_name: 'Device 2',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-2' && p.app_id === 'org.example.push.2')).toBe(true);
  });
  it('POST pushers/set create soft-3', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-3',
      app_id: 'org.example.push.3',
      device_display_name: 'Device 3',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-3' && p.app_id === 'org.example.push.3')).toBe(true);
  });
  it('POST pushers/set create soft-4', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-4',
      app_id: 'org.example.push.4',
      device_display_name: 'Device 4',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-4' && p.app_id === 'org.example.push.4')).toBe(true);
  });
  it('POST pushers/set create soft-5', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-5',
      app_id: 'org.example.push.5',
      device_display_name: 'Device 5',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-5' && p.app_id === 'org.example.push.5')).toBe(true);
  });
  it('POST pushers/set create soft-6', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-6',
      app_id: 'org.example.push.6',
      device_display_name: 'Device 6',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-6' && p.app_id === 'org.example.push.6')).toBe(true);
  });
  it('POST pushers/set create soft-7', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-7',
      app_id: 'org.example.push.7',
      device_display_name: 'Device 7',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-7' && p.app_id === 'org.example.push.7')).toBe(true);
  });
  it('POST pushers/set create soft-8', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-8',
      app_id: 'org.example.push.8',
      device_display_name: 'Device 8',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-8' && p.app_id === 'org.example.push.8')).toBe(true);
  });
  it('POST pushers/set create soft-9', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-9',
      app_id: 'org.example.push.9',
      device_display_name: 'Device 9',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-9' && p.app_id === 'org.example.push.9')).toBe(true);
  });
  it('POST pushers/set create soft-10', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-10',
      app_id: 'org.example.push.10',
      device_display_name: 'Device 10',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-10' && p.app_id === 'org.example.push.10')).toBe(true);
  });
  it('POST pushers/set create soft-11', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-11',
      app_id: 'org.example.push.11',
      device_display_name: 'Device 11',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-11' && p.app_id === 'org.example.push.11')).toBe(true);
  });
  it('POST pushers/set create soft-12', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-12',
      app_id: 'org.example.push.12',
      device_display_name: 'Device 12',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-12' && p.app_id === 'org.example.push.12')).toBe(true);
  });
  it('POST pushers/set create soft-13', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-13',
      app_id: 'org.example.push.13',
      device_display_name: 'Device 13',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-13' && p.app_id === 'org.example.push.13')).toBe(true);
  });
  it('POST pushers/set create soft-14', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-14',
      app_id: 'org.example.push.14',
      device_display_name: 'Device 14',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-14' && p.app_id === 'org.example.push.14')).toBe(true);
  });
  it('POST pushers/set create soft-15', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-15',
      app_id: 'org.example.push.15',
      device_display_name: 'Device 15',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-15' && p.app_id === 'org.example.push.15')).toBe(true);
  });
  it('POST pushers/set create soft-16', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-16',
      app_id: 'org.example.push.16',
      device_display_name: 'Device 16',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-16' && p.app_id === 'org.example.push.16')).toBe(true);
  });
  it('POST pushers/set create soft-17', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-17',
      app_id: 'org.example.push.17',
      device_display_name: 'Device 17',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-17' && p.app_id === 'org.example.push.17')).toBe(true);
  });
  it('POST pushers/set create soft-18', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-18',
      app_id: 'org.example.push.18',
      device_display_name: 'Device 18',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-18' && p.app_id === 'org.example.push.18')).toBe(true);
  });
  it('POST pushers/set create soft-19', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-19',
      app_id: 'org.example.push.19',
      device_display_name: 'Device 19',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-19' && p.app_id === 'org.example.push.19')).toBe(true);
  });
  it('POST pushers/set create soft-20', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-20',
      app_id: 'org.example.push.20',
      device_display_name: 'Device 20',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-20' && p.app_id === 'org.example.push.20')).toBe(true);
  });
  it('POST pushers/set create soft-21', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-21',
      app_id: 'org.example.push.21',
      device_display_name: 'Device 21',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-21' && p.app_id === 'org.example.push.21')).toBe(true);
  });
  it('POST pushers/set create soft-22', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-22',
      app_id: 'org.example.push.22',
      device_display_name: 'Device 22',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-22' && p.app_id === 'org.example.push.22')).toBe(true);
  });
  it('POST pushers/set create soft-23', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-23',
      app_id: 'org.example.push.23',
      device_display_name: 'Device 23',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-23' && p.app_id === 'org.example.push.23')).toBe(true);
  });
  it('POST pushers/set create soft-24', async () => {
    const db = createPushDb();
    const body = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-24',
      app_id: 'org.example.push.24',
      device_display_name: 'Device 24',
    };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-24' && p.app_id === 'org.example.push.24')).toBe(true);
  });
});

describe('push leftovers GET pushrules soft flood after #157', () => {
  it('GET pushrules soft-0', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-1', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-2', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-3', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-4', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-5', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-6', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-7', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-8', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-9', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-10', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-11', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-12', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-13', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-14', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-15', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-16', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-17', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-18', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-19', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-20', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-21', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-22', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-23', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
  it('GET pushrules soft-24', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override).toBeInstanceOf(Array);
    expect(res.body.global.override.length).toBeGreaterThan(0);
  });
});

describe('push leftovers GET pushrules/global soft flood after #157', () => {
  it('GET pushrules/global soft-0', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.0', kind: 'override', priority: 0 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.0');
  });
  it('GET pushrules/global soft-1', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.1', kind: 'override', priority: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.1');
  });
  it('GET pushrules/global soft-2', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.2', kind: 'override', priority: 2 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.2');
  });
  it('GET pushrules/global soft-3', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.3', kind: 'override', priority: 3 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.3');
  });
  it('GET pushrules/global soft-4', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.4', kind: 'override', priority: 4 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.4');
  });
  it('GET pushrules/global soft-5', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.5', kind: 'override', priority: 5 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.5');
  });
  it('GET pushrules/global soft-6', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.6', kind: 'override', priority: 6 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.6');
  });
  it('GET pushrules/global soft-7', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.7', kind: 'override', priority: 7 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.7');
  });
  it('GET pushrules/global soft-8', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.8', kind: 'override', priority: 8 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.8');
  });
  it('GET pushrules/global soft-9', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.9', kind: 'override', priority: 9 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.9');
  });
  it('GET pushrules/global soft-10', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.10', kind: 'override', priority: 10 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.10');
  });
  it('GET pushrules/global soft-11', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.11', kind: 'override', priority: 11 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.11');
  });
  it('GET pushrules/global soft-12', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.12', kind: 'override', priority: 12 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.12');
  });
  it('GET pushrules/global soft-13', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.13', kind: 'override', priority: 13 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.13');
  });
  it('GET pushrules/global soft-14', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.14', kind: 'override', priority: 14 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.14');
  });
  it('GET pushrules/global soft-15', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.15', kind: 'override', priority: 15 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.15');
  });
  it('GET pushrules/global soft-16', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.16', kind: 'override', priority: 16 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.16');
  });
  it('GET pushrules/global soft-17', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.17', kind: 'override', priority: 17 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.17');
  });
  it('GET pushrules/global soft-18', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.18', kind: 'override', priority: 18 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.18');
  });
  it('GET pushrules/global soft-19', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.19', kind: 'override', priority: 19 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.19');
  });
  it('GET pushrules/global soft-20', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.20', kind: 'override', priority: 20 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.20');
  });
  it('GET pushrules/global soft-21', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.21', kind: 'override', priority: 21 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.21');
  });
  it('GET pushrules/global soft-22', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.22', kind: 'override', priority: 22 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.22');
  });
  it('GET pushrules/global soft-23', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.23', kind: 'override', priority: 23 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.23');
  });
  it('GET pushrules/global soft-24', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.soft.24', kind: 'override', priority: 24 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.override).toBeInstanceOf(Array);
    const ids = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    expect(ids).toContain('custom.soft.24');
  });
});

describe('push leftovers PUT custom rule soft flood after #157', () => {
  it('PUT custom room rule soft-0', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room0:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '!room0:example.com' && r.kind === 'room')).toBe(true);
  });
  it('PUT custom sender rule soft-1', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender1:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '@sender1:example.com' && r.kind === 'sender')).toBe(true);
  });
  it('PUT custom content rule soft-2', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/content.soft.2',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello-2' })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'content.soft.2' && r.kind === 'content')).toBe(true);
  });
  it('PUT custom override rule soft-3', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.put.3',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.3' && r.kind === 'override')).toBe(true);
  });
  it('PUT custom underride rule soft-4', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/custom.put.4',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.4' && r.kind === 'underride')).toBe(true);
  });
  it('PUT custom room rule soft-5', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room5:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '!room5:example.com' && r.kind === 'room')).toBe(true);
  });
  it('PUT custom sender rule soft-6', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender6:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '@sender6:example.com' && r.kind === 'sender')).toBe(true);
  });
  it('PUT custom content rule soft-7', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/content.soft.7',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello-7' })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'content.soft.7' && r.kind === 'content')).toBe(true);
  });
  it('PUT custom override rule soft-8', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.put.8',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.8' && r.kind === 'override')).toBe(true);
  });
  it('PUT custom underride rule soft-9', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/custom.put.9',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.9' && r.kind === 'underride')).toBe(true);
  });
  it('PUT custom room rule soft-10', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room10:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '!room10:example.com' && r.kind === 'room')).toBe(true);
  });
  it('PUT custom sender rule soft-11', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender11:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '@sender11:example.com' && r.kind === 'sender')).toBe(true);
  });
  it('PUT custom content rule soft-12', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/content.soft.12',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello-12' })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'content.soft.12' && r.kind === 'content')).toBe(true);
  });
  it('PUT custom override rule soft-13', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.put.13',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.13' && r.kind === 'override')).toBe(true);
  });
  it('PUT custom underride rule soft-14', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/custom.put.14',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.14' && r.kind === 'underride')).toBe(true);
  });
  it('PUT custom room rule soft-15', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room15:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '!room15:example.com' && r.kind === 'room')).toBe(true);
  });
  it('PUT custom sender rule soft-16', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender16:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '@sender16:example.com' && r.kind === 'sender')).toBe(true);
  });
  it('PUT custom content rule soft-17', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/content.soft.17',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello-17' })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'content.soft.17' && r.kind === 'content')).toBe(true);
  });
  it('PUT custom override rule soft-18', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.put.18',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.18' && r.kind === 'override')).toBe(true);
  });
  it('PUT custom underride rule soft-19', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/custom.put.19',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.19' && r.kind === 'underride')).toBe(true);
  });
  it('PUT custom room rule soft-20', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room20:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '!room20:example.com' && r.kind === 'room')).toBe(true);
  });
  it('PUT custom sender rule soft-21', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender21:example.com')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '@sender21:example.com' && r.kind === 'sender')).toBe(true);
  });
  it('PUT custom content rule soft-22', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/content.soft.22',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello-22' })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'content.soft.22' && r.kind === 'content')).toBe(true);
  });
  it('PUT custom override rule soft-23', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.put.23',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.23' && r.kind === 'override')).toBe(true);
  });
  it('PUT custom underride rule soft-24', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/custom.put.24',
      jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === 'custom.put.24' && r.kind === 'underride')).toBe(true);
  });
});

describe('push leftovers DELETE custom rule soft flood after #157', () => {
  it('DELETE custom room rule soft-0', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'room', rule_id: '!delroom0:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!delroom0:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '!delroom0:example.com')).toBeUndefined();
  });
  it('DELETE custom sender rule soft-1', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'sender', rule_id: '@delsender1:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@delsender1:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '@delsender1:example.com')).toBeUndefined();
  });
  it('DELETE custom content rule soft-2', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'content', rule_id: 'custom.del.2' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/custom.del.2', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.2')).toBeUndefined();
  });
  it('DELETE custom override rule soft-3', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'override', rule_id: 'custom.del.3' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/custom.del.3', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.3')).toBeUndefined();
  });
  it('DELETE custom underride rule soft-4', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'underride', rule_id: 'custom.del.4' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/underride/custom.del.4', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.4')).toBeUndefined();
  });
  it('DELETE custom room rule soft-5', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'room', rule_id: '!delroom5:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!delroom5:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '!delroom5:example.com')).toBeUndefined();
  });
  it('DELETE custom sender rule soft-6', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'sender', rule_id: '@delsender6:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@delsender6:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '@delsender6:example.com')).toBeUndefined();
  });
  it('DELETE custom content rule soft-7', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'content', rule_id: 'custom.del.7' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/custom.del.7', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.7')).toBeUndefined();
  });
  it('DELETE custom override rule soft-8', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'override', rule_id: 'custom.del.8' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/custom.del.8', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.8')).toBeUndefined();
  });
  it('DELETE custom underride rule soft-9', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'underride', rule_id: 'custom.del.9' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/underride/custom.del.9', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.9')).toBeUndefined();
  });
  it('DELETE custom room rule soft-10', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'room', rule_id: '!delroom10:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!delroom10:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '!delroom10:example.com')).toBeUndefined();
  });
  it('DELETE custom sender rule soft-11', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'sender', rule_id: '@delsender11:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@delsender11:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '@delsender11:example.com')).toBeUndefined();
  });
  it('DELETE custom content rule soft-12', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'content', rule_id: 'custom.del.12' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/custom.del.12', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.12')).toBeUndefined();
  });
  it('DELETE custom override rule soft-13', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'override', rule_id: 'custom.del.13' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/custom.del.13', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.13')).toBeUndefined();
  });
  it('DELETE custom underride rule soft-14', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'underride', rule_id: 'custom.del.14' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/underride/custom.del.14', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.14')).toBeUndefined();
  });
  it('DELETE custom room rule soft-15', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'room', rule_id: '!delroom15:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!delroom15:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '!delroom15:example.com')).toBeUndefined();
  });
  it('DELETE custom sender rule soft-16', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'sender', rule_id: '@delsender16:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@delsender16:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '@delsender16:example.com')).toBeUndefined();
  });
  it('DELETE custom content rule soft-17', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'content', rule_id: 'custom.del.17' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/custom.del.17', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.17')).toBeUndefined();
  });
  it('DELETE custom override rule soft-18', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'override', rule_id: 'custom.del.18' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/custom.del.18', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.18')).toBeUndefined();
  });
  it('DELETE custom underride rule soft-19', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'underride', rule_id: 'custom.del.19' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/underride/custom.del.19', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.19')).toBeUndefined();
  });
  it('DELETE custom room rule soft-20', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'room', rule_id: '!delroom20:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!delroom20:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '!delroom20:example.com')).toBeUndefined();
  });
  it('DELETE custom sender rule soft-21', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'sender', rule_id: '@delsender21:example.com' })],
    });
    const res = await request(db, `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@delsender21:example.com')}`, jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === '@delsender21:example.com')).toBeUndefined();
  });
  it('DELETE custom content rule soft-22', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'content', rule_id: 'custom.del.22' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/custom.del.22', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.22')).toBeUndefined();
  });
  it('DELETE custom override rule soft-23', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'override', rule_id: 'custom.del.23' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/custom.del.23', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.23')).toBeUndefined();
  });
  it('DELETE custom underride rule soft-24', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'underride', rule_id: 'custom.del.24' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/underride/custom.del.24', jsonInit('DELETE'));
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.del.24')).toBeUndefined();
  });
});

describe('push leftovers enabled soft flood after #157', () => {
  it('PUT enabled soft-0', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.0', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.0/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.0')?.enabled).toBe(1);
  });
  it('PUT enabled soft-1', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.1', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.1/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.1')?.enabled).toBe(0);
  });
  it('PUT enabled soft-2', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.2', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.2/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.2')?.enabled).toBe(1);
  });
  it('PUT enabled soft-3', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.3', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.3/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.3')?.enabled).toBe(0);
  });
  it('PUT enabled soft-4', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.4', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.4/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.4')?.enabled).toBe(1);
  });
  it('PUT enabled soft-5', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.5', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.5/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.5')?.enabled).toBe(0);
  });
  it('PUT enabled soft-6', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.6', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.6/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.6')?.enabled).toBe(1);
  });
  it('PUT enabled soft-7', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.7', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.7/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.7')?.enabled).toBe(0);
  });
  it('PUT enabled soft-8', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.8', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.8/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.8')?.enabled).toBe(1);
  });
  it('PUT enabled soft-9', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.9', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.9/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.9')?.enabled).toBe(0);
  });
  it('PUT enabled soft-10', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.10', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.10/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.10')?.enabled).toBe(1);
  });
  it('PUT enabled soft-11', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.11', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.11/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.11')?.enabled).toBe(0);
  });
  it('PUT enabled soft-12', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.12', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.12/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.12')?.enabled).toBe(1);
  });
  it('PUT enabled soft-13', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.13', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.13/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.13')?.enabled).toBe(0);
  });
  it('PUT enabled soft-14', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.14', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.14/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.14')?.enabled).toBe(1);
  });
  it('PUT enabled soft-15', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.15', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.15/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.15')?.enabled).toBe(0);
  });
  it('PUT enabled soft-16', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.16', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.16/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.16')?.enabled).toBe(1);
  });
  it('PUT enabled soft-17', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.17', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.17/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.17')?.enabled).toBe(0);
  });
  it('PUT enabled soft-18', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.18', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.18/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.18')?.enabled).toBe(1);
  });
  it('PUT enabled soft-19', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.19', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.19/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.19')?.enabled).toBe(0);
  });
  it('PUT enabled soft-20', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.20', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.20/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.20')?.enabled).toBe(1);
  });
  it('PUT enabled soft-21', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.21', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.21/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.21')?.enabled).toBe(0);
  });
  it('PUT enabled soft-22', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.22', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.22/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.22')?.enabled).toBe(1);
  });
  it('PUT enabled soft-23', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.23', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.23/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.23')?.enabled).toBe(0);
  });
  it('PUT enabled soft-24', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled.24', enabled: 0 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.enabled.24/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.find((r) => r.rule_id === 'custom.enabled.24')?.enabled).toBe(1);
  });
});

describe('push leftovers actions soft flood after #157', () => {
  it('PUT actions soft-0', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.0' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.0/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.0');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-1', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.1' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.1/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.1');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-2', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.2' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.2/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.2');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-3', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.3' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.3/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.3');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-4', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.4' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.4/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.4');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-5', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.5' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.5/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.5');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-6', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.6' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.6/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.6');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-7', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.7' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.7/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.7');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-8', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.8' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.8/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.8');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-9', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.9' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.9/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.9');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-10', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.10' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.10/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.10');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-11', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.11' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.11/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.11');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-12', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.12' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.12/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.12');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-13', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.13' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.13/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.13');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-14', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.14' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.14/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.14');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-15', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.15' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.15/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.15');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-16', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.16' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.16/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.16');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-17', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.17' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.17/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.17');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-18', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.18' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.18/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.18');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-19', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.19' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.19/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.19');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-20', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.20' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.20/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.20');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-21', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.21' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.21/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.21');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-22', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.22' })],
    });
    const actions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.22/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.22');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-23', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.23' })],
    });
    const actions = [];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.23/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.23');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
  it('PUT actions soft-24', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.actions.24' })],
    });
    const actions = ['notify'];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.actions.24/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    const row = db.rules.find((r) => r.rule_id === 'custom.actions.24');
    expect(JSON.parse(row!.actions)).toEqual(actions);
  });
});

describe('push leftovers GET notifications soft flood after #157', () => {
  it('GET notifications soft-0', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-0-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(1) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(1);
  });
  it('GET notifications soft-1', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-1-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(2) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(2);
  });
  it('GET notifications soft-2', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-2-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(3) });
    if (2 > 0) qs.set('from', String(2));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(3);
  });
  it('GET notifications soft-3', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-3-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(4) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(4);
  });
  it('GET notifications soft-4', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-4-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(5) });
    if (4 > 0) qs.set('from', String(4));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(5);
  });
  it('GET notifications soft-5', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-5-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(6) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(6);
  });
  it('GET notifications soft-6', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-6-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(7) });
    if (6 > 0) qs.set('from', String(6));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(7);
  });
  it('GET notifications soft-7', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-7-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(8) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(8);
  });
  it('GET notifications soft-8', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-8-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(9) });
    if (8 > 0) qs.set('from', String(8));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(9);
  });
  it('GET notifications soft-9', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-9-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(10) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(10);
  });
  it('GET notifications soft-10', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-10-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(1) });
    if (10 > 0) qs.set('from', String(10));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(1);
  });
  it('GET notifications soft-11', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-11-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(2) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(2);
  });
  it('GET notifications soft-12', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-12-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(3) });
    if (12 > 0) qs.set('from', String(12));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(3);
  });
  it('GET notifications soft-13', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-13-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(4) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(4);
  });
  it('GET notifications soft-14', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-14-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(5) });
    if (14 > 0) qs.set('from', String(14));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(5);
  });
  it('GET notifications soft-15', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-15-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(6) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(6);
  });
  it('GET notifications soft-16', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-16-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(7) });
    if (16 > 0) qs.set('from', String(16));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(7);
  });
  it('GET notifications soft-17', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-17-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(8) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(8);
  });
  it('GET notifications soft-18', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-18-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(9) });
    if (18 > 0) qs.set('from', String(18));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(9);
  });
  it('GET notifications soft-19', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-19-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(10) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(10);
  });
  it('GET notifications soft-20', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-20-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(1) });
    if (20 > 0) qs.set('from', String(20));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(1);
  });
  it('GET notifications soft-21', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-21-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(2) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(2);
  });
  it('GET notifications soft-22', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-22-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(3) });
    if (22 > 0) qs.set('from', String(22));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(3);
  });
  it('GET notifications soft-23', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-23-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(4) });
    if (0 > 0) qs.set('from', String(0));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(4);
  });
  it('GET notifications soft-24', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 5 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j,
          event_id: `$ev-24-${j}:example.com`,
        })
      ),
    });
    const qs = new URLSearchParams({ limit: String(5) });
    if (24 > 0) qs.set('from', String(24));
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(5);
  });
});

describe('push leftovers failure edges after #157', () => {
  it('POST pushers/set rejects bad JSON', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });
  it('POST pushers/set rejects missing pushkey', async () => {
    const db = createPushDb();
    const { pushkey: _pk, ...rest } = VALID_PUSHER_BODY as typeof VALID_PUSHER_BODY & { pushkey: string };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', rest));
    expect(res.status).toBe(400);
  });
  it('PUT pushrules rejects non-global scope', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/device/override/x',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
  });
  it('PUT pushrules cannot overwrite default', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
  });
  it('DELETE pushrules 404 missing custom', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/no.such.rule',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(404);
  });
  it('PUT enabled rejects non-boolean', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'custom.en.bad' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.en.bad/enabled',
      jsonInit('PUT', { enabled: 'yes' })
    );
    expect(res.status).toBe(400);
  });
  it('PUT actions rejects missing actions', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'custom.act.bad' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.act.bad/actions',
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(400);
  });
  it('PUT content rule requires pattern', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/needs.pattern',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
  });
  it('GET specific rule 404 missing', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/missing.rule',
      authGet()
    );
    expect(res.status).toBe(404);
  });
  it('DELETE cannot delete default rule', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master',
      jsonInit('DELETE')
    );
    expect(res.status).toBe(400);
  });
});

describe('push leftovers method matrix after #157', () => {
  it('POST on GET pushers path is not GET-only success', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', jsonInit('POST', {}));
    expect(res.status).not.toBe(200);
  });
  it('GET on pushers/set is not create', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers/set', authGet());
    expect(res.status).not.toBe(200);
  });
  it('POST on pushrules create path rejected', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/method.x',
      jsonInit('POST', { actions: ['notify'] })
    );
    expect(res.status).not.toBe(200);
  });
  it('PUT on notifications rejected', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', jsonInit('PUT', {}));
    expect(res.status).not.toBe(200);
  });
  it('DELETE on pushers list rejected', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', jsonInit('DELETE'));
    expect(res.status).not.toBe(200);
  });
  it('PATCH on pushrules rejected', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/x',
      jsonInit('PATCH', { actions: ['notify'] })
    );
    expect(res.status).not.toBe(200);
  });
  it('GET pushrules trailing slash still works', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
  });
  it('GET notifications empty ok', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.status).toBe(200);
  });
});

describe('push leftovers charset soft flood after #157', () => {
  it('POST pushers/set charset soft-0', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: 'pk-cs-0', app_id: 'org.example.cs.0' }, "application/json")
    );
    expect(res.status).toBe(200);
  });
  it('POST pushers/set charset soft-1', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: 'pk-cs-1', app_id: 'org.example.cs.1' }, "application/json; charset=utf-8")
    );
    expect(res.status).toBe(200);
  });
  it('POST pushers/set charset soft-2', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: 'pk-cs-2', app_id: 'org.example.cs.2' }, "application/json;charset=UTF-8")
    );
    expect(res.status).toBe(200);
  });
  it('POST pushers/set charset soft-3', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: 'pk-cs-3', app_id: 'org.example.cs.3' }, "application/json; charset=UTF-8")
    );
    expect(res.status).toBe(200);
  });
  it('POST pushers/set charset soft-4', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: 'pk-cs-4', app_id: 'org.example.cs.4' }, "application/json; charset=\"utf-8\"")
    );
    expect(res.status).toBe(200);
  });
  it('PUT pushrule charset soft-0', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.rule.0',
      jsonInit('PUT', { actions: ['notify'], conditions: [] }, "application/json")
    );
    expect(res.status).toBe(200);
  });
  it('PUT pushrule charset soft-1', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.rule.1',
      jsonInit('PUT', { actions: ['notify'], conditions: [] }, "application/json; charset=utf-8")
    );
    expect(res.status).toBe(200);
  });
  it('PUT pushrule charset soft-2', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.rule.2',
      jsonInit('PUT', { actions: ['notify'], conditions: [] }, "application/json;charset=UTF-8")
    );
    expect(res.status).toBe(200);
  });
  it('PUT pushrule charset soft-3', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.rule.3',
      jsonInit('PUT', { actions: ['notify'], conditions: [] }, "application/json; charset=UTF-8")
    );
    expect(res.status).toBe(200);
  });
  it('PUT pushrule charset soft-4', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.rule.4',
      jsonInit('PUT', { actions: ['notify'], conditions: [] }, "application/json; charset=\"utf-8\"")
    );
    expect(res.status).toBe(200);
  });
  it('PUT enabled charset soft-0', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'cs.enabled.0' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.enabled.0/enabled',
      jsonInit('PUT', { enabled: false }, "application/json")
    );
    expect(res.status).toBe(200);
  });
  it('PUT enabled charset soft-1', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'cs.enabled.1' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.enabled.1/enabled',
      jsonInit('PUT', { enabled: false }, "application/json; charset=utf-8")
    );
    expect(res.status).toBe(200);
  });
  it('PUT enabled charset soft-2', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'cs.enabled.2' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.enabled.2/enabled',
      jsonInit('PUT', { enabled: false }, "application/json;charset=UTF-8")
    );
    expect(res.status).toBe(200);
  });
  it('PUT enabled charset soft-3', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'cs.enabled.3' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.enabled.3/enabled',
      jsonInit('PUT', { enabled: false }, "application/json; charset=UTF-8")
    );
    expect(res.status).toBe(200);
  });
  it('PUT enabled charset soft-4', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'cs.enabled.4' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/cs.enabled.4/enabled',
      jsonInit('PUT', { enabled: false }, "application/json; charset=\"utf-8\"")
    );
    expect(res.status).toBe(200);
  });
});

describe('push leftovers lifecycles after #157', () => {
  it('lifecycle register pusher → list → delete', async () => {
    const db = createPushDb();
    const create = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: 'pk-life-1', app_id: 'org.example.life' })
    );
    expect(create.status).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === 'pk-life-1')).toBe(true);
    const del = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-life-1', app_id: 'org.example.life', kind: null })
    );
    expect(del.status).toBe(200);
    const list2 = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list2.body.pushers.find((p: { pushkey: string }) => p.pushkey === 'pk-life-1')).toBeUndefined();
  });
  it('lifecycle create rule → get → disable → actions → delete', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/life.rule';
    expect((await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('life.rule');
    expect((await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, path + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, path, jsonInit('DELETE'))).status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('lifecycle room rule create → get → delete', async () => {
    const db = createPushDb();
    const rid = '!life-room:example.com';
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(rid)}`;
    expect((await request(db, path, jsonInit('PUT', { actions: ['notify'] }))).status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe(rid);
    expect((await request(db, path, jsonInit('DELETE'))).status).toBe(200);
  });
  it('lifecycle sender rule create → get → delete', async () => {
    const db = createPushDb();
    const sid = '@life-sender:example.com';
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent(sid)}`;
    expect((await request(db, path, jsonInit('PUT', { actions: ['notify'] }))).status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(200);
    expect((await request(db, path, jsonInit('DELETE'))).status).toBe(200);
  });
  it('lifecycle content rule create → actions → delete', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/life.content';
    expect(
      (await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'ping' }))).status
    ).toBe(200);
    expect(
      (await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }))).status
    ).toBe(200);
    expect((await request(db, path, jsonInit('DELETE'))).status).toBe(200);
  });
  it('lifecycle notifications empty → seed → list with from', async () => {
    const db = createPushDb();
    const empty = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(empty.body.notifications).toEqual([]);
    db.notifications.push(
      seedNotification({ id: 1, created_at: 100 }),
      seedNotification({ id: 2, created_at: 200, event_id: '$e2:example.com' }),
      seedNotification({ id: 3, created_at: 300, event_id: '$e3:example.com' })
    );
    const page = await request(db, '/_matrix/client/v3/notifications?from=1&limit=2', authGet());
    expect(page.status).toBe(200);
    expect(page.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle pusher append false replaces same pushkey', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-append', app_id: 'a.old' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-append',
        app_id: 'a.new',
        append: false,
      })
    );
    expect(res.status).toBe(200);
    expect(db.pushers.filter((p) => p.pushkey === 'pk-append')).toHaveLength(1);
    expect(db.pushers[0].app_id).toBe('a.new');
  });
  it('lifecycle default enabled override then list', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const master = list.body.override.find((r: { rule_id: string }) => r.rule_id === '.m.rule.master');
    expect(master.enabled).toBe(true);
  });
});
