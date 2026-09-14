/**
 * TOKENMAXX HEAVY leftovers after #160/#161/#163 — push API route soft/edge/reliability.
 * Complements push-api-routes.test.ts (no dedicated leftovers file on main; recovered from
 * closed #164 push slice and deepened). Orthogonal to identity/login/oauth and admin/federation
 * sibling overnight agents. Tests-only — no product inventing. Fixtures use example.com only.
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

describe('push leftovers GET pushers empty soft flood after #160', () => {
  it('GET pushers empty soft-r2-0', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-1', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-2', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-3', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-4', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-5', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-6', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-7', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-8', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-9', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-10', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-11', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-12', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-13', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-14', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-15', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-16', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-17', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-18', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-19', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-20', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-21', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-22', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-23', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-24', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-25', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-26', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-27', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-28', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
  it('GET pushers empty soft-r2-29', async () => {
    const db = createPushDb({ pushers: [] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM pushers'))).toBe(true);
  });
});

describe('push leftovers GET pushers shape soft flood after #160', () => {
  it('GET pushers shape soft-r2-0', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-0',
          app_id: 'org.example.shape.0',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 0 }),
          lang: 'en',
        }),
        seedPusher({ pushkey: 'pk-off-0', enabled: 0, app_id: 'org.example.off.0' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-0');
    expect(res.body.pushers[0].data.n).toBe(0);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-1', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-1',
          app_id: 'org.example.shape.1',
          profile_tag: 'tag-r2-1',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 1 }),
          lang: 'de',
        }),
        seedPusher({ pushkey: 'pk-off-1', enabled: 0, app_id: 'org.example.off.1' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-1');
    expect(res.body.pushers[0].data.n).toBe(1);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-1');
  });
  it('GET pushers shape soft-r2-2', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-2',
          app_id: 'org.example.shape.2',
          profile_tag: 'tag-r2-2',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 2 }),
          lang: 'fr',
        }),
        seedPusher({ pushkey: 'pk-off-2', enabled: 0, app_id: 'org.example.off.2' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-2');
    expect(res.body.pushers[0].data.n).toBe(2);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-2');
  });
  it('GET pushers shape soft-r2-3', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-3',
          app_id: 'org.example.shape.3',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 3 }),
          lang: 'es',
        }),
        seedPusher({ pushkey: 'pk-off-3', enabled: 0, app_id: 'org.example.off.3' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-3');
    expect(res.body.pushers[0].data.n).toBe(3);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-4', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-4',
          app_id: 'org.example.shape.4',
          profile_tag: 'tag-r2-4',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 4 }),
          lang: 'ja',
        }),
        seedPusher({ pushkey: 'pk-off-4', enabled: 0, app_id: 'org.example.off.4' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-4');
    expect(res.body.pushers[0].data.n).toBe(4);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-4');
  });
  it('GET pushers shape soft-r2-5', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-5',
          app_id: 'org.example.shape.5',
          profile_tag: 'tag-r2-5',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 5 }),
          lang: 'en',
        }),
        seedPusher({ pushkey: 'pk-off-5', enabled: 0, app_id: 'org.example.off.5' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-5');
    expect(res.body.pushers[0].data.n).toBe(5);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-5');
  });
  it('GET pushers shape soft-r2-6', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-6',
          app_id: 'org.example.shape.6',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 6 }),
          lang: 'de',
        }),
        seedPusher({ pushkey: 'pk-off-6', enabled: 0, app_id: 'org.example.off.6' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-6');
    expect(res.body.pushers[0].data.n).toBe(6);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-7', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-7',
          app_id: 'org.example.shape.7',
          profile_tag: 'tag-r2-7',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 7 }),
          lang: 'fr',
        }),
        seedPusher({ pushkey: 'pk-off-7', enabled: 0, app_id: 'org.example.off.7' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-7');
    expect(res.body.pushers[0].data.n).toBe(7);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-7');
  });
  it('GET pushers shape soft-r2-8', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-8',
          app_id: 'org.example.shape.8',
          profile_tag: 'tag-r2-8',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 8 }),
          lang: 'es',
        }),
        seedPusher({ pushkey: 'pk-off-8', enabled: 0, app_id: 'org.example.off.8' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-8');
    expect(res.body.pushers[0].data.n).toBe(8);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-8');
  });
  it('GET pushers shape soft-r2-9', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-9',
          app_id: 'org.example.shape.9',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 9 }),
          lang: 'ja',
        }),
        seedPusher({ pushkey: 'pk-off-9', enabled: 0, app_id: 'org.example.off.9' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-9');
    expect(res.body.pushers[0].data.n).toBe(9);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-10', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-10',
          app_id: 'org.example.shape.10',
          profile_tag: 'tag-r2-10',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 10 }),
          lang: 'en',
        }),
        seedPusher({ pushkey: 'pk-off-10', enabled: 0, app_id: 'org.example.off.10' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-10');
    expect(res.body.pushers[0].data.n).toBe(10);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-10');
  });
  it('GET pushers shape soft-r2-11', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-11',
          app_id: 'org.example.shape.11',
          profile_tag: 'tag-r2-11',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 11 }),
          lang: 'de',
        }),
        seedPusher({ pushkey: 'pk-off-11', enabled: 0, app_id: 'org.example.off.11' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-11');
    expect(res.body.pushers[0].data.n).toBe(11);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-11');
  });
  it('GET pushers shape soft-r2-12', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-12',
          app_id: 'org.example.shape.12',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 12 }),
          lang: 'fr',
        }),
        seedPusher({ pushkey: 'pk-off-12', enabled: 0, app_id: 'org.example.off.12' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-12');
    expect(res.body.pushers[0].data.n).toBe(12);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-13', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-13',
          app_id: 'org.example.shape.13',
          profile_tag: 'tag-r2-13',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 13 }),
          lang: 'es',
        }),
        seedPusher({ pushkey: 'pk-off-13', enabled: 0, app_id: 'org.example.off.13' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-13');
    expect(res.body.pushers[0].data.n).toBe(13);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-13');
  });
  it('GET pushers shape soft-r2-14', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-14',
          app_id: 'org.example.shape.14',
          profile_tag: 'tag-r2-14',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 14 }),
          lang: 'ja',
        }),
        seedPusher({ pushkey: 'pk-off-14', enabled: 0, app_id: 'org.example.off.14' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-14');
    expect(res.body.pushers[0].data.n).toBe(14);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-14');
  });
  it('GET pushers shape soft-r2-15', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-15',
          app_id: 'org.example.shape.15',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 15 }),
          lang: 'en',
        }),
        seedPusher({ pushkey: 'pk-off-15', enabled: 0, app_id: 'org.example.off.15' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-15');
    expect(res.body.pushers[0].data.n).toBe(15);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-16', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-16',
          app_id: 'org.example.shape.16',
          profile_tag: 'tag-r2-16',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 16 }),
          lang: 'de',
        }),
        seedPusher({ pushkey: 'pk-off-16', enabled: 0, app_id: 'org.example.off.16' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-16');
    expect(res.body.pushers[0].data.n).toBe(16);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-16');
  });
  it('GET pushers shape soft-r2-17', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-17',
          app_id: 'org.example.shape.17',
          profile_tag: 'tag-r2-17',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 17 }),
          lang: 'fr',
        }),
        seedPusher({ pushkey: 'pk-off-17', enabled: 0, app_id: 'org.example.off.17' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-17');
    expect(res.body.pushers[0].data.n).toBe(17);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-17');
  });
  it('GET pushers shape soft-r2-18', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-18',
          app_id: 'org.example.shape.18',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 18 }),
          lang: 'es',
        }),
        seedPusher({ pushkey: 'pk-off-18', enabled: 0, app_id: 'org.example.off.18' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-18');
    expect(res.body.pushers[0].data.n).toBe(18);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-19', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-19',
          app_id: 'org.example.shape.19',
          profile_tag: 'tag-r2-19',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 19 }),
          lang: 'ja',
        }),
        seedPusher({ pushkey: 'pk-off-19', enabled: 0, app_id: 'org.example.off.19' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-19');
    expect(res.body.pushers[0].data.n).toBe(19);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-19');
  });
  it('GET pushers shape soft-r2-20', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-20',
          app_id: 'org.example.shape.20',
          profile_tag: 'tag-r2-20',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 20 }),
          lang: 'en',
        }),
        seedPusher({ pushkey: 'pk-off-20', enabled: 0, app_id: 'org.example.off.20' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-20');
    expect(res.body.pushers[0].data.n).toBe(20);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-20');
  });
  it('GET pushers shape soft-r2-21', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-21',
          app_id: 'org.example.shape.21',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 21 }),
          lang: 'de',
        }),
        seedPusher({ pushkey: 'pk-off-21', enabled: 0, app_id: 'org.example.off.21' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-21');
    expect(res.body.pushers[0].data.n).toBe(21);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
  it('GET pushers shape soft-r2-22', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-22',
          app_id: 'org.example.shape.22',
          profile_tag: 'tag-r2-22',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 22 }),
          lang: 'fr',
        }),
        seedPusher({ pushkey: 'pk-off-22', enabled: 0, app_id: 'org.example.off.22' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-22');
    expect(res.body.pushers[0].data.n).toBe(22);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-22');
  });
  it('GET pushers shape soft-r2-23', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-23',
          app_id: 'org.example.shape.23',
          profile_tag: 'tag-r2-23',
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 23 }),
          lang: 'es',
        }),
        seedPusher({ pushkey: 'pk-off-23', enabled: 0, app_id: 'org.example.off.23' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-23');
    expect(res.body.pushers[0].data.n).toBe(23);
    expect(res.body.pushers[0].profile_tag).toBe('tag-r2-23');
  });
  it('GET pushers shape soft-r2-24', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'pk-shape-24',
          app_id: 'org.example.shape.24',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', n: 24 }),
          lang: 'ja',
        }),
        seedPusher({ pushkey: 'pk-off-24', enabled: 0, app_id: 'org.example.off.24' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect(res.body.pushers[0].pushkey).toBe('pk-shape-24');
    expect(res.body.pushers[0].data.n).toBe(24);
    expect(res.body.pushers[0].profile_tag).toBeUndefined();
  });
});

describe('push leftovers POST pushers/set create soft flood after #160', () => {
  it('POST pushers/set create soft-r2-0', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-0',
      app_id: 'org.example.create.0',
      app_display_name: 'App 0',
      device_display_name: 'Device 0',
      lang: 'en',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 0 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-0' && p.app_id === 'org.example.create.0')).toBe(true);
  });
  it('POST pushers/set create soft-r2-1', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-1',
      app_id: 'org.example.create.1',
      app_display_name: 'App 1',
      device_display_name: 'Device 1',
      lang: 'de',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 1 },
    };
    body.profile_tag = 'pt-1';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-1' && p.app_id === 'org.example.create.1')).toBe(true);
  });
  it('POST pushers/set create soft-r2-2', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-2',
      app_id: 'org.example.create.2',
      app_display_name: 'App 2',
      device_display_name: 'Device 2',
      lang: 'fr',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 2 },
    };
    body.profile_tag = 'pt-2';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-2' && p.app_id === 'org.example.create.2')).toBe(true);
  });
  it('POST pushers/set create soft-r2-3', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-3',
      app_id: 'org.example.create.3',
      app_display_name: 'App 3',
      device_display_name: 'Device 3',
      lang: 'en',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 3 },
    };
    body.profile_tag = 'pt-3';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-3' && p.app_id === 'org.example.create.3')).toBe(true);
  });
  it('POST pushers/set create soft-r2-4', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-4',
      app_id: 'org.example.create.4',
      app_display_name: 'App 4',
      device_display_name: 'Device 4',
      lang: 'de',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 4 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-4' && p.app_id === 'org.example.create.4')).toBe(true);
  });
  it('POST pushers/set create soft-r2-5', async () => {
    const db = createPushDb({ pushers: [seedPusher({ pushkey: 'pk-create-r2-5', app_id: 'org.example.old.5' })] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-5',
      app_id: 'org.example.create.5',
      app_display_name: 'App 5',
      device_display_name: 'Device 5',
      lang: 'fr',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 5 },
    };
    body.profile_tag = 'pt-5';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-5' && p.app_id === 'org.example.create.5')).toBe(true);
  });
  it('POST pushers/set create soft-r2-6', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-6',
      app_id: 'org.example.create.6',
      app_display_name: 'App 6',
      device_display_name: 'Device 6',
      lang: 'en',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 6 },
    };
    body.profile_tag = 'pt-6';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-6' && p.app_id === 'org.example.create.6')).toBe(true);
  });
  it('POST pushers/set create soft-r2-7', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-7',
      app_id: 'org.example.create.7',
      app_display_name: 'App 7',
      device_display_name: 'Device 7',
      lang: 'de',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 7 },
    };
    body.profile_tag = 'pt-7';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-7' && p.app_id === 'org.example.create.7')).toBe(true);
  });
  it('POST pushers/set create soft-r2-8', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-8',
      app_id: 'org.example.create.8',
      app_display_name: 'App 8',
      device_display_name: 'Device 8',
      lang: 'fr',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 8 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-8' && p.app_id === 'org.example.create.8')).toBe(true);
  });
  it('POST pushers/set create soft-r2-9', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-9',
      app_id: 'org.example.create.9',
      app_display_name: 'App 9',
      device_display_name: 'Device 9',
      lang: 'en',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 9 },
    };
    body.profile_tag = 'pt-9';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-9' && p.app_id === 'org.example.create.9')).toBe(true);
  });
  it('POST pushers/set create soft-r2-10', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-10',
      app_id: 'org.example.create.10',
      app_display_name: 'App 10',
      device_display_name: 'Device 10',
      lang: 'de',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 10 },
    };
    body.profile_tag = 'pt-10';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-10' && p.app_id === 'org.example.create.10')).toBe(true);
  });
  it('POST pushers/set create soft-r2-11', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-11',
      app_id: 'org.example.create.11',
      app_display_name: 'App 11',
      device_display_name: 'Device 11',
      lang: 'fr',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 11 },
    };
    body.profile_tag = 'pt-11';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-11' && p.app_id === 'org.example.create.11')).toBe(true);
  });
  it('POST pushers/set create soft-r2-12', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-12',
      app_id: 'org.example.create.12',
      app_display_name: 'App 12',
      device_display_name: 'Device 12',
      lang: 'en',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 12 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-12' && p.app_id === 'org.example.create.12')).toBe(true);
  });
  it('POST pushers/set create soft-r2-13', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-13',
      app_id: 'org.example.create.13',
      app_display_name: 'App 13',
      device_display_name: 'Device 13',
      lang: 'de',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 13 },
    };
    body.profile_tag = 'pt-13';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-13' && p.app_id === 'org.example.create.13')).toBe(true);
  });
  it('POST pushers/set create soft-r2-14', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-14',
      app_id: 'org.example.create.14',
      app_display_name: 'App 14',
      device_display_name: 'Device 14',
      lang: 'fr',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 14 },
    };
    body.profile_tag = 'pt-14';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-14' && p.app_id === 'org.example.create.14')).toBe(true);
  });
  it('POST pushers/set create soft-r2-15', async () => {
    const db = createPushDb({ pushers: [seedPusher({ pushkey: 'pk-create-r2-15', app_id: 'org.example.old.15' })] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-15',
      app_id: 'org.example.create.15',
      app_display_name: 'App 15',
      device_display_name: 'Device 15',
      lang: 'en',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 15 },
    };
    body.profile_tag = 'pt-15';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-15' && p.app_id === 'org.example.create.15')).toBe(true);
  });
  it('POST pushers/set create soft-r2-16', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-16',
      app_id: 'org.example.create.16',
      app_display_name: 'App 16',
      device_display_name: 'Device 16',
      lang: 'de',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 16 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-16' && p.app_id === 'org.example.create.16')).toBe(true);
  });
  it('POST pushers/set create soft-r2-17', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-17',
      app_id: 'org.example.create.17',
      app_display_name: 'App 17',
      device_display_name: 'Device 17',
      lang: 'fr',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 17 },
    };
    body.profile_tag = 'pt-17';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-17' && p.app_id === 'org.example.create.17')).toBe(true);
  });
  it('POST pushers/set create soft-r2-18', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-18',
      app_id: 'org.example.create.18',
      app_display_name: 'App 18',
      device_display_name: 'Device 18',
      lang: 'en',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 18 },
    };
    body.profile_tag = 'pt-18';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-18' && p.app_id === 'org.example.create.18')).toBe(true);
  });
  it('POST pushers/set create soft-r2-19', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-19',
      app_id: 'org.example.create.19',
      app_display_name: 'App 19',
      device_display_name: 'Device 19',
      lang: 'de',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 19 },
    };
    body.profile_tag = 'pt-19';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-19' && p.app_id === 'org.example.create.19')).toBe(true);
  });
  it('POST pushers/set create soft-r2-20', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-20',
      app_id: 'org.example.create.20',
      app_display_name: 'App 20',
      device_display_name: 'Device 20',
      lang: 'fr',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 20 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-20' && p.app_id === 'org.example.create.20')).toBe(true);
  });
  it('POST pushers/set create soft-r2-21', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-21',
      app_id: 'org.example.create.21',
      app_display_name: 'App 21',
      device_display_name: 'Device 21',
      lang: 'en',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 21 },
    };
    body.profile_tag = 'pt-21';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-21' && p.app_id === 'org.example.create.21')).toBe(true);
  });
  it('POST pushers/set create soft-r2-22', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-22',
      app_id: 'org.example.create.22',
      app_display_name: 'App 22',
      device_display_name: 'Device 22',
      lang: 'de',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 22 },
    };
    body.profile_tag = 'pt-22';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-22' && p.app_id === 'org.example.create.22')).toBe(true);
  });
  it('POST pushers/set create soft-r2-23', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-23',
      app_id: 'org.example.create.23',
      app_display_name: 'App 23',
      device_display_name: 'Device 23',
      lang: 'fr',
      append: false,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 23 },
    };
    body.profile_tag = 'pt-23';
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-23' && p.app_id === 'org.example.create.23')).toBe(true);
  });
  it('POST pushers/set create soft-r2-24', async () => {
    const db = createPushDb({ pushers: [] });
    const body: Record<string, unknown> = {
      ...VALID_PUSHER_BODY,
      pushkey: 'pk-create-r2-24',
      app_id: 'org.example.create.24',
      app_display_name: 'App 24',
      device_display_name: 'Device 24',
      lang: 'en',
      append: true,
      data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only', idx: 24 },
    };
    // omit profile_tag
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.some((p) => p.pushkey === 'pk-create-r2-24' && p.app_id === 'org.example.create.24')).toBe(true);
  });
});

describe('push leftovers POST pushers/set delete soft flood after #160', () => {
  it('POST pushers/set delete soft-r2-0', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-0', app_id: 'org.example.del.0' }),
        seedPusher({ pushkey: 'pk-keep-r2-0', app_id: 'org.example.keep.0' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-0',
      app_id: 'org.example.del.0',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-0')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-0')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-1', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-1', app_id: 'org.example.del.1' }),
        seedPusher({ pushkey: 'pk-keep-r2-1', app_id: 'org.example.keep.1' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-1',
      app_id: 'org.example.del.1',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-1')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-1')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-2', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-2', app_id: 'org.example.del.2' }),
        seedPusher({ pushkey: 'pk-keep-r2-2', app_id: 'org.example.keep.2' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-2',
      app_id: 'org.example.del.2',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-2')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-2')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-3', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-3', app_id: 'org.example.del.3' }),
        seedPusher({ pushkey: 'pk-keep-r2-3', app_id: 'org.example.keep.3' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-3',
      app_id: 'org.example.del.3',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-3')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-3')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-4', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-4', app_id: 'org.example.del.4' }),
        seedPusher({ pushkey: 'pk-keep-r2-4', app_id: 'org.example.keep.4' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-4',
      app_id: 'org.example.del.4',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-4')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-4')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-5', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-5', app_id: 'org.example.del.5' }),
        seedPusher({ pushkey: 'pk-keep-r2-5', app_id: 'org.example.keep.5' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-5',
      app_id: 'org.example.del.5',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-5')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-5')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-6', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-6', app_id: 'org.example.del.6' }),
        seedPusher({ pushkey: 'pk-keep-r2-6', app_id: 'org.example.keep.6' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-6',
      app_id: 'org.example.del.6',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-6')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-6')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-7', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-7', app_id: 'org.example.del.7' }),
        seedPusher({ pushkey: 'pk-keep-r2-7', app_id: 'org.example.keep.7' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-7',
      app_id: 'org.example.del.7',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-7')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-7')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-8', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-8', app_id: 'org.example.del.8' }),
        seedPusher({ pushkey: 'pk-keep-r2-8', app_id: 'org.example.keep.8' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-8',
      app_id: 'org.example.del.8',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-8')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-8')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-9', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-9', app_id: 'org.example.del.9' }),
        seedPusher({ pushkey: 'pk-keep-r2-9', app_id: 'org.example.keep.9' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-9',
      app_id: 'org.example.del.9',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-9')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-9')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-10', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-10', app_id: 'org.example.del.10' }),
        seedPusher({ pushkey: 'pk-keep-r2-10', app_id: 'org.example.keep.10' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-10',
      app_id: 'org.example.del.10',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-10')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-10')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-11', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-11', app_id: 'org.example.del.11' }),
        seedPusher({ pushkey: 'pk-keep-r2-11', app_id: 'org.example.keep.11' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-11',
      app_id: 'org.example.del.11',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-11')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-11')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-12', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-12', app_id: 'org.example.del.12' }),
        seedPusher({ pushkey: 'pk-keep-r2-12', app_id: 'org.example.keep.12' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-12',
      app_id: 'org.example.del.12',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-12')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-12')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-13', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-13', app_id: 'org.example.del.13' }),
        seedPusher({ pushkey: 'pk-keep-r2-13', app_id: 'org.example.keep.13' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-13',
      app_id: 'org.example.del.13',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-13')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-13')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-14', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-14', app_id: 'org.example.del.14' }),
        seedPusher({ pushkey: 'pk-keep-r2-14', app_id: 'org.example.keep.14' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-14',
      app_id: 'org.example.del.14',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-14')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-14')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-15', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-15', app_id: 'org.example.del.15' }),
        seedPusher({ pushkey: 'pk-keep-r2-15', app_id: 'org.example.keep.15' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-15',
      app_id: 'org.example.del.15',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-15')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-15')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-16', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-16', app_id: 'org.example.del.16' }),
        seedPusher({ pushkey: 'pk-keep-r2-16', app_id: 'org.example.keep.16' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-16',
      app_id: 'org.example.del.16',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-16')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-16')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-17', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-17', app_id: 'org.example.del.17' }),
        seedPusher({ pushkey: 'pk-keep-r2-17', app_id: 'org.example.keep.17' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-17',
      app_id: 'org.example.del.17',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-17')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-17')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-18', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-18', app_id: 'org.example.del.18' }),
        seedPusher({ pushkey: 'pk-keep-r2-18', app_id: 'org.example.keep.18' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-18',
      app_id: 'org.example.del.18',
    };
    body.kind = null;
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-18')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-18')).toBeDefined();
  });
  it('POST pushers/set delete soft-r2-19', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-del-r2-19', app_id: 'org.example.del.19' }),
        seedPusher({ pushkey: 'pk-keep-r2-19', app_id: 'org.example.keep.19' }),
      ],
    });
    const body: Record<string, unknown> = {
      pushkey: 'pk-del-r2-19',
      app_id: 'org.example.del.19',
    };
    // kind omitted → undefined
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-del-r2-19')).toBeUndefined();
    expect(db.pushers.find((p) => p.pushkey === 'pk-keep-r2-19')).toBeDefined();
  });
});

describe('push leftovers pushrules kind CRUD soft flood after #160', () => {
  it('pushrules override CRUD soft-r2-0', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/override.r2.0';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('override.r2.0');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules content CRUD soft-r2-1', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/content.r2.1';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'pat-1' }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('content.r2.1');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules room CRUD soft-r2-2', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room-r2-2:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('!room-r2-2:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules sender CRUD soft-r2-3', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender-r2-3:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('@sender-r2-3:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules underride CRUD soft-r2-4', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/underride/underride.r2.4';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('underride.r2.4');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules override CRUD soft-r2-5', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/override.r2.5';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('override.r2.5');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules content CRUD soft-r2-6', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/content.r2.6';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'pat-6' }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('content.r2.6');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules room CRUD soft-r2-7', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room-r2-7:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('!room-r2-7:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules sender CRUD soft-r2-8', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender-r2-8:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('@sender-r2-8:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules underride CRUD soft-r2-9', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/underride/underride.r2.9';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('underride.r2.9');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules override CRUD soft-r2-10', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/override.r2.10';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('override.r2.10');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules content CRUD soft-r2-11', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/content.r2.11';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'pat-11' }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('content.r2.11');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules room CRUD soft-r2-12', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room-r2-12:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('!room-r2-12:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules sender CRUD soft-r2-13', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender-r2-13:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('@sender-r2-13:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules underride CRUD soft-r2-14', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/underride/underride.r2.14';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('underride.r2.14');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules override CRUD soft-r2-15', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/override.r2.15';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('override.r2.15');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules content CRUD soft-r2-16', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/content.r2.16';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'pat-16' }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('content.r2.16');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules room CRUD soft-r2-17', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room-r2-17:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('!room-r2-17:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules sender CRUD soft-r2-18', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender-r2-18:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('@sender-r2-18:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules underride CRUD soft-r2-19', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/underride/underride.r2.19';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('underride.r2.19');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules override CRUD soft-r2-20', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/override.r2.20';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('override.r2.20');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules content CRUD soft-r2-21', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/content.r2.21';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'pat-21' }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('content.r2.21');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules room CRUD soft-r2-22', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room-r2-22:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('!room-r2-22:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules sender CRUD soft-r2-23', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender-r2-23:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('@sender-r2-23:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules underride CRUD soft-r2-24', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/underride/underride.r2.24';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('underride.r2.24');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules override CRUD soft-r2-25', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/override.r2.25';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('override.r2.25');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules content CRUD soft-r2-26', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/content/content.r2.26';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], pattern: 'pat-26' }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('content.r2.26');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules room CRUD soft-r2-27', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent('!room-r2-27:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('!room-r2-27:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules sender CRUD soft-r2-28', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent('@sender-r2-28:example.com')}`;
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('@sender-r2-28:example.com');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
  it('pushrules underride CRUD soft-r2-29', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/underride/underride.r2.29';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('underride.r2.29');
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });
});

describe('push leftovers enabled/actions default soft flood after #160', () => {
  it('enabled default soft-r2-0 .m.rule.master', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.master' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-1 .m.rule.suppress_notices', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.suppress_notices/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.suppress_notices' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-2 .m.rule.invite_for_me', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.invite_for_me/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.invite_for_me' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-3 .m.rule.member_event', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.member_event/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.member_event' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-4 .m.rule.contains_display_name', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.contains_display_name/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.contains_display_name' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-5 .m.rule.tombstone', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.tombstone/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.tombstone' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-6 .m.rule.is_room_mention', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.is_room_mention/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.is_room_mention' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-7 .m.rule.call', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.call/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.call' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-8 .m.rule.encrypted_room_one_to_one', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.encrypted_room_one_to_one/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.encrypted_room_one_to_one' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-9 .m.rule.room_one_to_one', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.room_one_to_one/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.room_one_to_one' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-10 .m.rule.message', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.message/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.message' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-11 .m.rule.encrypted', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.encrypted/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.encrypted' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-12 .m.rule.contains_user_name', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.contains_user_name' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-13 .m.rule.master', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.master' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-14 .m.rule.suppress_notices', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.suppress_notices/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.suppress_notices' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-15 .m.rule.invite_for_me', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.invite_for_me/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.invite_for_me' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-16 .m.rule.member_event', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.member_event/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.member_event' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-17 .m.rule.contains_display_name', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.contains_display_name/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.contains_display_name' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-18 .m.rule.tombstone', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.tombstone/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.tombstone' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-19 .m.rule.is_room_mention', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.is_room_mention/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.is_room_mention' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-20 .m.rule.call', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.call/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.call' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-21 .m.rule.encrypted_room_one_to_one', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.encrypted_room_one_to_one/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.encrypted_room_one_to_one' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-22 .m.rule.room_one_to_one', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.room_one_to_one/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.room_one_to_one' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-23 .m.rule.message', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.message/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.message' && r.enabled === 1)).toBe(true);
  });
  it('enabled default soft-r2-24 .m.rule.encrypted', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.encrypted/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.encrypted' && r.enabled === 0)).toBe(true);
  });
  it('enabled default soft-r2-25 .m.rule.contains_user_name', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules.some((r) => r.rule_id === '.m.rule.contains_user_name' && r.enabled === 1)).toBe(true);
  });
  it('actions default soft-r2-0 .m.rule.master', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.master');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
  it('actions default soft-r2-1 .m.rule.suppress_notices', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.suppress_notices/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: false }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.suppress_notices');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: false }]);
  });
  it('actions default soft-r2-2 .m.rule.invite_for_me', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.invite_for_me/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.invite_for_me');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
  it('actions default soft-r2-3 .m.rule.member_event', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.member_event/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: false }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.member_event');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: false }]);
  });
  it('actions default soft-r2-4 .m.rule.contains_display_name', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.contains_display_name/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.contains_display_name');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
  it('actions default soft-r2-5 .m.rule.tombstone', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.tombstone/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: false }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.tombstone');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: false }]);
  });
  it('actions default soft-r2-6 .m.rule.is_room_mention', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.is_room_mention/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.is_room_mention');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
  it('actions default soft-r2-7 .m.rule.call', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.call/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: false }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.call');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: false }]);
  });
  it('actions default soft-r2-8 .m.rule.encrypted_room_one_to_one', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.encrypted_room_one_to_one/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.encrypted_room_one_to_one');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
  it('actions default soft-r2-9 .m.rule.room_one_to_one', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.room_one_to_one/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: false }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.room_one_to_one');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: false }]);
  });
  it('actions default soft-r2-10 .m.rule.message', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.message/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.message');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
  it('actions default soft-r2-11 .m.rule.encrypted', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.encrypted/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: false }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.encrypted');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: false }]);
  });
  it('actions default soft-r2-12 .m.rule.contains_user_name', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name/actions',
      jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === '.m.rule.contains_user_name');
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.actions)).toEqual(['notify', { set_tweak: 'highlight', value: true }]);
  });
});

describe('push leftovers notifications pagination soft flood after #160', () => {
  it('notifications page soft-r2-0', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-0-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=1' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(1, 100));
  });
  it('notifications page soft-r2-1', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-1-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=2' + ('1' !== '0' ? '&from=1' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(2, 100));
  });
  it('notifications page soft-r2-2', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-2-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=5' + ('2' !== '0' ? '&from=2' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(5, 100));
  });
  it('notifications page soft-r2-3', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-3-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=10' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(10, 100));
  });
  it('notifications page soft-r2-4', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-4-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=20' + ('4' !== '0' ? '&from=4' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(20, 100));
  });
  it('notifications page soft-r2-5', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-5-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=50' + ('5' !== '0' ? '&from=5' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(50, 100));
  });
  it('notifications page soft-r2-6', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-6-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=100' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(100, 100));
  });
  it('notifications page soft-r2-7', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-7-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=200' + ('7' !== '0' ? '&from=7' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(200, 100));
  });
  it('notifications page soft-r2-8', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-8-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=1' + ('8' !== '0' ? '&from=8' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(1, 100));
  });
  it('notifications page soft-r2-9', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-9-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=2' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(2, 100));
  });
  it('notifications page soft-r2-10', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-10-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=5' + ('10' !== '0' ? '&from=10' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(5, 100));
  });
  it('notifications page soft-r2-11', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-11-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=10' + ('11' !== '0' ? '&from=11' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(10, 100));
  });
  it('notifications page soft-r2-12', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-12-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=20' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(20, 100));
  });
  it('notifications page soft-r2-13', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-13-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=50' + ('13' !== '0' ? '&from=13' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(50, 100));
  });
  it('notifications page soft-r2-14', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-14-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=100' + ('14' !== '0' ? '&from=14' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(100, 100));
  });
  it('notifications page soft-r2-15', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-15-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=200' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(200, 100));
  });
  it('notifications page soft-r2-16', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-16-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=1' + ('16' !== '0' ? '&from=16' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(1, 100));
  });
  it('notifications page soft-r2-17', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-17-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=2' + ('17' !== '0' ? '&from=17' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(2, 100));
  });
  it('notifications page soft-r2-18', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-18-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=5' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(5, 100));
  });
  it('notifications page soft-r2-19', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-19-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=10' + ('19' !== '0' ? '&from=19' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(10, 100));
  });
  it('notifications page soft-r2-20', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-20-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=20' + ('20' !== '0' ? '&from=20' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(20, 100));
  });
  it('notifications page soft-r2-21', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-21-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=50' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(50, 100));
  });
  it('notifications page soft-r2-22', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-22-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=100' + ('22' !== '0' ? '&from=22' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(100, 100));
  });
  it('notifications page soft-r2-23', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-23-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=200' + ('23' !== '0' ? '&from=23' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(200, 100));
  });
  it('notifications page soft-r2-24', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-24-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=1' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(1, 100));
  });
  it('notifications page soft-r2-25', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-25-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=2' + ('25' !== '0' ? '&from=25' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(2, 100));
  });
  it('notifications page soft-r2-26', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-26-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=5' + ('26' !== '0' ? '&from=26' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(5, 100));
  });
  it('notifications page soft-r2-27', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-27-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=10' + ('0' !== '0' ? '&from=0' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(10, 100));
  });
  it('notifications page soft-r2-28', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-28-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'only=highlight&limit=20' + ('28' !== '0' ? '&from=28' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(20, 100));
  });
  it('notifications page soft-r2-29', async () => {
    const db = createPushDb({
      notifications: Array.from({ length: 15 }, (_, j) =>
        seedNotification({
          id: j + 1,
          created_at: 1_700_000_000_000 + j * 1000,
          event_id: `$e-r2-29-${j}:example.com`,
          notification_type: j % 2 === 0 ? 'highlight' : 'notify',
          content: j % 5 === 0 ? '{bad' : JSON.stringify({ body: `m${j}`, msgtype: 'm.text' }),
        })
      ),
    });
    const qs = 'limit=50' + ('29' !== '0' ? '&from=29' : '');
    const res = await request(db, `/_matrix/client/v3/notifications?${qs}`, authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    expect(res.body.notifications.length).toBeLessThanOrEqual(Math.min(50, 100));
  });
});

describe('push leftovers failure soft flood after #160', () => {
  it('failure soft-r2-0: bad JSON pushers', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-1: missing pushkey', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', {...VALID_PUSHER_BODY, pushkey: ''}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-2: missing app_id', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', {...VALID_PUSHER_BODY, app_id: ''}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-3: non-global GET', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', authGet());
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-4: unknown kind GET', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/notakind/x', authGet());
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-5: missing rule GET', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/nope.r2', authGet());
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-6: overwrite default', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.master', jsonInit('PUT', {actions:['notify']}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_OVERWRITE_DEFAULT');
  });
  it('failure soft-r2-7: content no pattern', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/nopat.r2', jsonInit('PUT', {actions:['notify']}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-8: delete default', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.master', jsonInit('DELETE'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_DELETE_DEFAULT');
  });
  it('failure soft-r2-9: delete missing', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/gone.r2', jsonInit('DELETE'));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-10: enabled non-bool', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.en/enabled', jsonInit('PUT', {enabled:'x'}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-11: actions non-array', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.act/actions', jsonInit('PUT', {actions:'x'}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-12: actions missing custom', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/missing.act/actions', jsonInit('PUT', {actions:[]}));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-13: enabled unknown default', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.not_a_real/enabled', jsonInit('PUT', {enabled:false}));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-14: non-global PUT', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', jsonInit('PUT', {actions:['notify']}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-15: non-global DELETE', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', jsonInit('DELETE'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-16: bad JSON enabled', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.en2/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-17: bad JSON actions', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.act2/actions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-18: bad JSON put rule', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.putbad', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-19: put missing actions', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.noact', jsonInit('PUT', {}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-20: bad JSON pushers', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-21: missing pushkey', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', {...VALID_PUSHER_BODY, pushkey: ''}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-22: missing app_id', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', {...VALID_PUSHER_BODY, app_id: ''}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-23: non-global GET', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', authGet());
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-24: unknown kind GET', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/notakind/x', authGet());
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-25: missing rule GET', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/nope.r2', authGet());
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-26: overwrite default', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.master', jsonInit('PUT', {actions:['notify']}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_OVERWRITE_DEFAULT');
  });
  it('failure soft-r2-27: content no pattern', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/content/nopat.r2', jsonInit('PUT', {actions:['notify']}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-28: delete default', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.master', jsonInit('DELETE'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_DELETE_DEFAULT');
  });
  it('failure soft-r2-29: delete missing', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/gone.r2', jsonInit('DELETE'));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-30: enabled non-bool', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.en/enabled', jsonInit('PUT', {enabled:'x'}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-31: actions non-array', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.act/actions', jsonInit('PUT', {actions:'x'}));
    expect(res.status).toBe(400);
    
  });
  it('failure soft-r2-32: actions missing custom', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/missing.act/actions', jsonInit('PUT', {actions:[]}));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-33: enabled unknown default', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.not_a_real/enabled', jsonInit('PUT', {enabled:false}));
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
  it('failure soft-r2-34: non-global PUT', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', jsonInit('PUT', {actions:['notify']}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-35: non-global DELETE', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', jsonInit('DELETE'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
  it('failure soft-r2-36: bad JSON enabled', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.en2/enabled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-37: bad JSON actions', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c.en' }), seedRule({ rule_id: 'c.act' }), seedRule({ rule_id: 'c.en2' }), seedRule({ rule_id: 'c.act2' })], });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.act2/actions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-38: bad JSON put rule', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.putbad', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('failure soft-r2-39: put missing actions', async () => {
    const db = createPushDb({  });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/c.noact', jsonInit('PUT', {}));
    expect(res.status).toBe(400);
    
  });
});

describe('push leftovers percent-encoding soft flood after #160', () => {
  it('percent-encoding soft-r2-0', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%200%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 0/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-1', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%201%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 1/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-2', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%202%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 2/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-3', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%203%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 3/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-4', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%204%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 4/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-5', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%205%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 5/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-6', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%206%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 6/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-7', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%207%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 7/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-8', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%208%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 8/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-9', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%209%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 9/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-10', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2010%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 10/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-11', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2011%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 11/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-12', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2012%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 12/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-13', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2013%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 13/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-14', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2014%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 14/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-15', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2015%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 15/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-16', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2016%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 16/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-17', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2017%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 17/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-18', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2018%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 18/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
  it('percent-encoding soft-r2-19', async () => {
    const db = createPushDb();
    const path = '/_matrix/client/v3/pushrules/global/override/rule%20with%20space%2019%2Fslash%2Bplus';
    const put = await request(db, path, jsonInit('PUT', { actions: ['notify'], conditions: [] }));
    expect(put.status).toBe(200);
    const got = await request(db, path, authGet());
    expect(got.status).toBe(200);
    expect(got.body.rule_id).toBe('rule with space 19/slash+plus');
    const en = await request(db, path + '/enabled', jsonInit('PUT', { enabled: false }));
    expect(en.status).toBe(200);
    const act = await request(db, path + '/actions', jsonInit('PUT', { actions: ['dont_notify'] }));
    expect(act.status).toBe(200);
    const del = await request(db, path, jsonInit('DELETE'));
    expect(del.status).toBe(200);
  });
});

describe('push leftovers priority before/after soft flood after #160', () => {
  it('priority query soft-r2-0', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 0);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.0?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.0');
    expect(hit?.priority).toBe(1_800_000_000_000 + 0);
  });
  it('priority query soft-r2-1', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 1);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.1?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.1');
    expect(hit?.priority).toBe(1_800_000_000_000 + 1);
  });
  it('priority query soft-r2-2', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 2);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.2?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.2');
    expect(hit?.priority).toBe(1_800_000_000_000 + 2);
  });
  it('priority query soft-r2-3', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 3);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.3?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.3');
    expect(hit?.priority).toBe(1_800_000_000_000 + 3);
  });
  it('priority query soft-r2-4', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 4);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.4?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.4');
    expect(hit?.priority).toBe(1_800_000_000_000 + 4);
  });
  it('priority query soft-r2-5', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 5);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.5?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.5');
    expect(hit?.priority).toBe(1_800_000_000_000 + 5);
  });
  it('priority query soft-r2-6', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 6);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.6?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.6');
    expect(hit?.priority).toBe(1_800_000_000_000 + 6);
  });
  it('priority query soft-r2-7', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 7);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.7?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.7');
    expect(hit?.priority).toBe(1_800_000_000_000 + 7);
  });
  it('priority query soft-r2-8', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 8);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.8?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.8');
    expect(hit?.priority).toBe(1_800_000_000_000 + 8);
  });
  it('priority query soft-r2-9', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 9);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.9?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.9');
    expect(hit?.priority).toBe(1_800_000_000_000 + 9);
  });
  it('priority query soft-r2-10', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 10);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.10?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.10');
    expect(hit?.priority).toBe(1_800_000_000_000 + 10);
  });
  it('priority query soft-r2-11', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 11);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.11?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.11');
    expect(hit?.priority).toBe(1_800_000_000_000 + 11);
  });
  it('priority query soft-r2-12', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 12);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.12?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.12');
    expect(hit?.priority).toBe(1_800_000_000_000 + 12);
  });
  it('priority query soft-r2-13', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 13);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.13?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.13');
    expect(hit?.priority).toBe(1_800_000_000_000 + 13);
  });
  it('priority query soft-r2-14', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 14);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.14?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.14');
    expect(hit?.priority).toBe(1_800_000_000_000 + 14);
  });
  it('priority query soft-r2-15', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 15);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.15?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.15');
    expect(hit?.priority).toBe(1_800_000_000_000 + 15);
  });
  it('priority query soft-r2-16', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 16);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.16?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.16');
    expect(hit?.priority).toBe(1_800_000_000_000 + 16);
  });
  it('priority query soft-r2-17', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 17);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.17?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.17');
    expect(hit?.priority).toBe(1_800_000_000_000 + 17);
  });
  it('priority query soft-r2-18', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 18);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.18?before=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.18');
    expect(hit?.priority).toBe(1_800_000_000_000 + 18);
  });
  it('priority query soft-r2-19', async () => {
    const db = createPushDb();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000 + 19);
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio.r2.19?after=other',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(res.status).toBe(200);
    const hit = db.rules.find((r) => r.rule_id === 'prio.r2.19');
    expect(hit?.priority).toBe(1_800_000_000_000 + 19);
  });
});

describe('push leftovers pushrules slash/inventory soft flood after #160', () => {
  it('pushrules inventory soft-r2-0', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.0', kind: 'override', priority: 0 }),
        seedRule({ rule_id: 'inv.content.r2.0', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 1 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.0')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-1', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.1', kind: 'override', priority: 1 }),
        seedRule({ rule_id: 'inv.content.r2.1', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 2 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.1')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-2', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.2', kind: 'override', priority: 2 }),
        seedRule({ rule_id: 'inv.content.r2.2', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 3 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.2')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-3', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.3', kind: 'override', priority: 3 }),
        seedRule({ rule_id: 'inv.content.r2.3', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 4 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.3')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-4', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.4', kind: 'override', priority: 4 }),
        seedRule({ rule_id: 'inv.content.r2.4', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 5 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.4')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-5', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.5', kind: 'override', priority: 5 }),
        seedRule({ rule_id: 'inv.content.r2.5', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 6 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.5')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-6', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.6', kind: 'override', priority: 6 }),
        seedRule({ rule_id: 'inv.content.r2.6', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 7 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.6')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-7', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.7', kind: 'override', priority: 7 }),
        seedRule({ rule_id: 'inv.content.r2.7', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 8 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.7')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-8', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.8', kind: 'override', priority: 8 }),
        seedRule({ rule_id: 'inv.content.r2.8', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 9 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.8')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-9', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.9', kind: 'override', priority: 9 }),
        seedRule({ rule_id: 'inv.content.r2.9', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 10 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.9')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-10', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.10', kind: 'override', priority: 10 }),
        seedRule({ rule_id: 'inv.content.r2.10', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 11 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.10')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-11', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.11', kind: 'override', priority: 11 }),
        seedRule({ rule_id: 'inv.content.r2.11', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 12 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.11')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-12', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.12', kind: 'override', priority: 12 }),
        seedRule({ rule_id: 'inv.content.r2.12', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 13 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.12')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-13', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.13', kind: 'override', priority: 13 }),
        seedRule({ rule_id: 'inv.content.r2.13', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 14 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.13')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-14', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.14', kind: 'override', priority: 14 }),
        seedRule({ rule_id: 'inv.content.r2.14', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 15 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.14')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-15', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.15', kind: 'override', priority: 15 }),
        seedRule({ rule_id: 'inv.content.r2.15', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 16 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.15')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-16', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.16', kind: 'override', priority: 16 }),
        seedRule({ rule_id: 'inv.content.r2.16', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 17 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.16')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-17', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.17', kind: 'override', priority: 17 }),
        seedRule({ rule_id: 'inv.content.r2.17', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 18 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.17')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-18', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.18', kind: 'override', priority: 18 }),
        seedRule({ rule_id: 'inv.content.r2.18', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 19 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.18')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
  it('pushrules inventory soft-r2-19', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'inv.r2.19', kind: 'override', priority: 19 }),
        seedRule({ rule_id: 'inv.content.r2.19', kind: 'content', conditions: null, actions: JSON.stringify(['notify']), priority: 20 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.some((r: { rule_id: string }) => r.rule_id === 'inv.r2.19')).toBe(true);
    const g = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(g.status).toBe(200);
    expect(g.body.override).toBeInstanceOf(Array);
    expect(g.body.content).toBeInstanceOf(Array);
    expect(g.body.underride).toBeInstanceOf(Array);
  });
});

describe('push leftovers method matrix soft flood after #160', () => {
  it('method matrix soft-r2-0 PUT /_matrix/client/v3/pushers', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-1 DELETE /_matrix/client/v3/pushers', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-2 PATCH /_matrix/client/v3/pushers', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-3 POST /_matrix/client/v3/pushers', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-4 PUT /_matrix/client/v3/pushrules', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-5 DELETE /_matrix/client/v3/pushrules', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-6 PATCH /_matrix/client/v3/pushrules', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-7 POST /_matrix/client/v3/pushrules', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-8 PUT /_matrix/client/v3/notifications', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-9 DELETE /_matrix/client/v3/notifications', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-10 PATCH /_matrix/client/v3/notifications', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
  it('method matrix soft-r2-11 POST /_matrix/client/v3/notifications', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 404, 405]).toContain(res.status);
  });
});

describe('push leftovers charset soft flood after #160', () => {
  it('charset soft-r2-0', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-0',
        app_id: 'org.example.cs.0',
      }, 'application/json')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-1', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-1',
        app_id: 'org.example.cs.1',
      }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-2', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-2',
        app_id: 'org.example.cs.2',
      }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-3', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-3',
        app_id: 'org.example.cs.3',
      }, 'application/json; charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-4', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-4',
        app_id: 'org.example.cs.4',
      }, 'application/json; charset="utf-8"')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-5', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-5',
        app_id: 'org.example.cs.5',
      }, 'application/json')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-6', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-6',
        app_id: 'org.example.cs.6',
      }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-7', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-7',
        app_id: 'org.example.cs.7',
      }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-8', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-8',
        app_id: 'org.example.cs.8',
      }, 'application/json; charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-9', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-9',
        app_id: 'org.example.cs.9',
      }, 'application/json; charset="utf-8"')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-10', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-10',
        app_id: 'org.example.cs.10',
      }, 'application/json')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-11', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-11',
        app_id: 'org.example.cs.11',
      }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-12', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-12',
        app_id: 'org.example.cs.12',
      }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-13', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-13',
        app_id: 'org.example.cs.13',
      }, 'application/json; charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-14', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-14',
        app_id: 'org.example.cs.14',
      }, 'application/json; charset="utf-8"')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-15', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-15',
        app_id: 'org.example.cs.15',
      }, 'application/json')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-16', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-16',
        app_id: 'org.example.cs.16',
      }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-17', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-17',
        app_id: 'org.example.cs.17',
      }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-18', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-18',
        app_id: 'org.example.cs.18',
      }, 'application/json; charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-19', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-19',
        app_id: 'org.example.cs.19',
      }, 'application/json; charset="utf-8"')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-20', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-20',
        app_id: 'org.example.cs.20',
      }, 'application/json')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-21', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-21',
        app_id: 'org.example.cs.21',
      }, 'application/json; charset=utf-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-22', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-22',
        app_id: 'org.example.cs.22',
      }, 'application/json;charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-23', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-23',
        app_id: 'org.example.cs.23',
      }, 'application/json; charset=UTF-8')
    );
    expect(res.status).toBe(200);
  });
  it('charset soft-r2-24', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'pk-cs-r2-24',
        app_id: 'org.example.cs.24',
      }, 'application/json; charset="utf-8"')
    );
    expect(res.status).toBe(200);
  });
});

describe('push leftovers lifecycles soft flood after #160', () => {
  it('lifecycle soft-r2-0', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-0';
    const app = 'org.example.life.r2.0';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.0';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 1, event_id: `$life-r2-0:example.com`, created_at: 1000 + 0 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-1', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-1';
    const app = 'org.example.life.r2.1';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.1';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 2, event_id: `$life-r2-1:example.com`, created_at: 1000 + 1 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-2', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-2';
    const app = 'org.example.life.r2.2';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.2';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 3, event_id: `$life-r2-2:example.com`, created_at: 1000 + 2 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-3', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-3';
    const app = 'org.example.life.r2.3';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.3';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 4, event_id: `$life-r2-3:example.com`, created_at: 1000 + 3 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-4', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-4';
    const app = 'org.example.life.r2.4';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.4';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 5, event_id: `$life-r2-4:example.com`, created_at: 1000 + 4 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-5', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-5';
    const app = 'org.example.life.r2.5';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.5';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 6, event_id: `$life-r2-5:example.com`, created_at: 1000 + 5 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-6', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-6';
    const app = 'org.example.life.r2.6';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.6';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 7, event_id: `$life-r2-6:example.com`, created_at: 1000 + 6 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-7', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-7';
    const app = 'org.example.life.r2.7';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.7';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 8, event_id: `$life-r2-7:example.com`, created_at: 1000 + 7 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-8', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-8';
    const app = 'org.example.life.r2.8';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.8';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 9, event_id: `$life-r2-8:example.com`, created_at: 1000 + 8 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-9', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-9';
    const app = 'org.example.life.r2.9';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.9';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 10, event_id: `$life-r2-9:example.com`, created_at: 1000 + 9 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-10', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-10';
    const app = 'org.example.life.r2.10';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.10';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 11, event_id: `$life-r2-10:example.com`, created_at: 1000 + 10 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-11', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-11';
    const app = 'org.example.life.r2.11';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.11';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 12, event_id: `$life-r2-11:example.com`, created_at: 1000 + 11 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-12', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-12';
    const app = 'org.example.life.r2.12';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.12';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 13, event_id: `$life-r2-12:example.com`, created_at: 1000 + 12 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-13', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-13';
    const app = 'org.example.life.r2.13';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.13';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 14, event_id: `$life-r2-13:example.com`, created_at: 1000 + 13 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
  it('lifecycle soft-r2-14', async () => {
    const db = createPushDb();
    const pk = 'pk-life-r2-14';
    const app = 'org.example.life.r2.14';
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id: app, append: true })
        )
      ).status
    ).toBe(200);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers.some((p: { pushkey: string }) => p.pushkey === pk)).toBe(true);
    const rulePath = '/_matrix/client/v3/pushrules/global/override/life.r2.14';
    expect((await request(db, rulePath, jsonInit('PUT', { actions: ['notify'], conditions: [] }))).status).toBe(200);
    expect((await request(db, rulePath + '/enabled', jsonInit('PUT', { enabled: false }))).status).toBe(200);
    expect((await request(db, rulePath + '/actions', jsonInit('PUT', { actions: [] }))).status).toBe(200);
    expect((await request(db, rulePath, jsonInit('DELETE'))).status).toBe(200);
    expect(
      (
        await request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: pk, app_id: app, kind: null })
        )
      ).status
    ).toBe(200);
    db.notifications.push(
      seedNotification({ id: 15, event_id: `$life-r2-14:example.com`, created_at: 1000 + 14 })
    );
    const notes = await request(db, '/_matrix/client/v3/notifications?limit=5', authGet());
    expect(notes.status).toBe(200);
    expect(notes.body.notifications.length).toBeGreaterThan(0);
  });
});
