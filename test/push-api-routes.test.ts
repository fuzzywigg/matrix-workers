/**
 * TOKENMAXX HEAVY deepen after #100/#101/#102/#103/#124 — different slice: push API routes.
 * Avoids devices/federation/sliding-sync/sync/voip/rooms/oidc/media/relations.
 * Login/account suites already thick; this file deepens leftover push client routes.
 * Tests-only — no product inventing.
 * Exercises pushers, pushrules CRUD/enabled/actions, and notifications via Hono app.request().
 * Helper evaluate/match coverage lives in push-rules.test.ts / push-delivery.test.ts.
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

// ============================================
// Pushers
// ============================================

describe('push GET /_matrix/client/v3/pushers', () => {
  it('returns empty pushers list when none registered', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pushers: [] });
  });

  it('maps enabled pushers and omits null profile_tag', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ profile_tag: 'mobile' }),
        seedPusher({
          pushkey: 'pk-2',
          app_id: 'org.element.backup',
          profile_tag: null,
          data: JSON.stringify({ url: 'https://backup.example.com/notify' }),
        }),
        seedPusher({ pushkey: 'pk-disabled', enabled: 0 }),
        seedPusher({ user_id: BOB, pushkey: 'pk-bob' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(2);
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: 'pk-1',
      kind: 'http',
      app_id: 'im.vector.app',
      profile_tag: 'mobile',
      data: { url: 'https://push.example.com/_matrix/push/v1/notify' },
    });
    expect(res.body.pushers[1].profile_tag).toBeUndefined();
    expect(res.body.pushers[1].data.url).toBe('https://backup.example.com/notify');
  });

  it('parses nested pusher data objects', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          data: JSON.stringify({
            url: 'https://push.example.com/notify',
            format: 'event_id_only',
            custom: { nested: true },
          }),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.body.pushers[0].data).toEqual({
      url: 'https://push.example.com/notify',
      format: 'event_id_only',
      custom: { nested: true },
    });
  });
});

describe('push POST /_matrix/client/v3/pushers/set', () => {
  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('rejects missing pushkey', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { kind: 'http', app_id: 'x' })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
    expect(res.body.error).toContain('pushkey');
  });

  it('deletes pusher when kind is null', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-del', app_id: 'im.vector.app' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-del', kind: null, app_id: 'im.vector.app' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.pushers).toHaveLength(0);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM pushers'))).toBe(true);
  });

  it('deletes pusher when kind is omitted (undefined)', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-u', app_id: 'app.a' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-u', app_id: 'app.a' })
    );
    expect(res.status).toBe(200);
    expect(db.pushers).toHaveLength(0);
  });

  it('uses empty app_id when deleting without app_id', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-empty', app_id: '' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-empty', kind: null })
    );
    expect(res.status).toBe(200);
    expect(db.pushers).toHaveLength(0);
    expect(db.deletes[0].args[2]).toBe('');
  });

  it('rejects create when required fields are missing', async () => {
    const db = createPushDb();
    const cases = [
      { pushkey: 'pk', kind: 'http' },
      { pushkey: 'pk', kind: 'http', app_id: 'a' },
      { pushkey: 'pk', kind: 'http', app_id: 'a', app_display_name: 'A' },
      {
        pushkey: 'pk',
        kind: 'http',
        app_id: 'a',
        app_display_name: 'A',
        device_display_name: 'D',
      },
      {
        pushkey: 'pk',
        kind: 'http',
        app_id: 'a',
        app_display_name: 'A',
        device_display_name: 'D',
        lang: 'en',
      },
    ];
    for (const body of cases) {
      const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('creates a pusher and replaces same pushkey when append is false', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'pk-new', app_id: 'old.app' }),
        seedPusher({ pushkey: 'pk-other', app_id: 'keep.app' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, append: false, profile_tag: 'main' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    // old same-pushkey removed, other pushkey kept, new inserted
    expect(db.pushers.map((p) => p.app_id).sort()).toEqual(['im.vector.app', 'keep.app']);
    const created = db.pushers.find((p) => p.pushkey === 'pk-new');
    expect(created).toMatchObject({
      kind: 'http',
      app_display_name: 'Element',
      device_display_name: 'Pixel',
      profile_tag: 'main',
      lang: 'en',
    });
    expect(JSON.parse(created!.data)).toEqual(VALID_PUSHER_BODY.data);
  });

  it('keeps existing same-pushkey pushers when append is true', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-new', app_id: 'old.app' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, append: true })
    );
    expect(res.status).toBe(200);
    expect(db.pushers).toHaveLength(2);
    expect(db.pushers.map((p) => p.app_id).sort()).toEqual(['im.vector.app', 'old.app']);
  });

  it('upserts on conflict for same user/pushkey/app_id', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-new', app_id: 'im.vector.app', lang: 'de' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, lang: 'fr', profile_tag: undefined })
    );
    expect(res.status).toBe(200);
    expect(db.pushers).toHaveLength(1);
    expect(db.pushers[0].lang).toBe('fr');
    expect(db.pushers[0].profile_tag).toBeNull();
  });

  it('stores null profile_tag when omitted on create', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', VALID_PUSHER_BODY)
    );
    expect(res.status).toBe(200);
    expect(db.pushers[0].profile_tag).toBeNull();
  });
});

// ============================================
// Push rules — list / get
// ============================================

describe('push GET /_matrix/client/v3/pushrules', () => {
  it('returns default global rules customized for the user', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.override.length).toBeGreaterThan(5);
    expect(res.body.global.content).toHaveLength(1);
    expect(res.body.global.room).toEqual([]);
    expect(res.body.global.sender).toEqual([]);
    expect(res.body.global.underride.length).toBeGreaterThan(3);

    const invite = res.body.global.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.invite_for_me'
    );
    expect(invite.conditions.find((c: { key?: string }) => c.key === 'state_key').pattern).toBe(
      USER
    );

    const mention = res.body.global.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.is_user_mention'
    );
    expect(
      mention.conditions.find((c: { key?: string }) => c.key?.includes('user_ids')).value
    ).toBe(USER);

    const containsName = res.body.global.content.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.contains_user_name'
    );
    expect(containsName.pattern).toBe('alice');
  });

  it('GET with trailing slash returns the same shape', async () => {
    const db = createPushDb();
    const a = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const b = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    expect(b.status).toBe(200);
    expect(b.body.global.override.map((r: { rule_id: string }) => r.rule_id)).toEqual(
      a.body.global.override.map((r: { rule_id: string }) => r.rule_id)
    );
  });

  it('GET /pushrules/global returns only the global object', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.status).toBe(200);
    expect(res.body.global).toBeUndefined();
    expect(res.body.override).toBeDefined();
    expect(res.body.content).toBeDefined();
    expect(res.body.underride).toBeDefined();
  });

  it('merges custom rules: overrides defaults and prepends new ones', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: '.m.rule.master',
          kind: 'override',
          enabled: 1,
          actions: JSON.stringify(['notify']),
          conditions: null,
          priority: 1,
        }),
        seedRule({
          rule_id: 'my.keyword',
          kind: 'content',
          actions: JSON.stringify(['notify', { set_tweak: 'highlight', value: true }]),
          conditions: JSON.stringify([{ kind: 'event_match', key: 'content.body', pattern: 'urgent' }]),
          priority: 0,
        }),
        seedRule({
          rule_id: 'room.quiet',
          kind: 'room',
          actions: JSON.stringify(['dont_notify']),
          conditions: null,
          priority: 2,
        }),
        seedRule({
          rule_id: 'sender.mute',
          kind: 'sender',
          actions: JSON.stringify(['dont_notify']),
          conditions: null,
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const master = res.body.global.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.master'
    );
    expect(master.enabled).toBe(true);
    expect(master.actions).toEqual(['notify']);
    expect(master.default).toBe(true);

    expect(res.body.global.content[0].rule_id).toBe('my.keyword');
    expect(res.body.global.content[0].default).toBe(false);
    expect(res.body.global.room).toHaveLength(1);
    expect(res.body.global.sender[0].rule_id).toBe('sender.mute');
  });

  it('tolerates malformed conditions/actions JSON on custom rules', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'broken.json',
          conditions: '{not-json',
          actions: 'also-bad',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    const broken = res.body.global.override.find(
      (r: { rule_id: string }) => r.rule_id === 'broken.json'
    );
    expect(broken.conditions).toBeUndefined();
    expect(broken.actions).toEqual([]);
  });

  it('ignores custom rules with unknown kind keys', async () => {
    const db = createPushDb({
      rules: [seedRule({ kind: 'not_a_kind', rule_id: 'ghost' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(res.status).toBe(200);
    const flat = [
      ...res.body.global.override,
      ...res.body.global.content,
      ...res.body.global.room,
      ...res.body.global.sender,
      ...res.body.global.underride,
    ];
    expect(flat.some((r: { rule_id: string }) => r.rule_id === 'ghost')).toBe(false);
  });
});

describe('push GET /_matrix/client/v3/pushrules/:scope/:kind/:ruleId', () => {
  it('rejects non-global scope', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/device/override/.m.rule.master',
      authGet()
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
    expect(res.body.error).toContain('global');
  });

  it('rejects unknown kind', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/weird/.m.rule.master',
      authGet()
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
    expect(res.body.error).toContain('Unknown rule kind');
  });

  it('returns 404 when rule is missing', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/does.not.exist',
      authGet()
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns a default override rule', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master',
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rule_id: '.m.rule.master',
      default: true,
      enabled: false,
      actions: ['dont_notify'],
    });
  });

  it('returns underride and content defaults', async () => {
    const db = createPushDb();
    const call = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.call',
      authGet()
    );
    expect(call.status).toBe(200);
    expect(call.body.rule_id).toBe('.m.rule.call');

    const content = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name',
      authGet()
    );
    expect(content.status).toBe(200);
    expect(content.body.pattern).toBe('alice');
  });

  it('returns custom rules and decodes URL-encoded rule ids', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'my rule/with spaces', kind: 'override' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent('my rule/with spaces')}`,
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body.rule_id).toBe('my rule/with spaces');
    expect(res.body.default).toBe(false);
  });

  it('returns overridden default after custom DB merge', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: '.m.rule.reaction',
          kind: 'override',
          enabled: 0,
          actions: JSON.stringify(['notify']),
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.reaction' },
          ]),
        }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.reaction',
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.actions).toEqual(['notify']);
  });
});

// ============================================
// Push rules — create / delete
// ============================================

describe('push PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId', () => {
  it('rejects non-global scope', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/device/override/r1',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('cannot overwrite default .m.rule.* rules', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_OVERWRITE_DEFAULT');
  });

  it('rejects bad JSON', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/r1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'null{',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('requires actions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/r1',
      jsonInit('PUT', { conditions: [] })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
    expect(res.body.error).toContain('actions');
  });

  it('requires pattern for content kind', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/keyword',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
    expect(res.body.error).toContain('pattern');
  });

  it('creates an override rule with conditions', async () => {
    const db = createPushDb();
    const conditions = [{ kind: 'event_match', key: 'content.body', pattern: 'ping' }];
    const actions = ['notify', { set_tweak: 'sound', value: 'default' }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.ping',
      jsonInit('PUT', { actions, conditions })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0]).toMatchObject({
      user_id: USER,
      kind: 'override',
      rule_id: 'custom.ping',
      enabled: 1,
      priority: 0,
    });
    expect(JSON.parse(db.rules[0].actions)).toEqual(actions);
    expect(JSON.parse(db.rules[0].conditions!)).toEqual(conditions);
  });

  it('creates a content rule with pattern', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/kw.hello',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello' })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].rule_id).toBe('kw.hello');
    // pattern is accepted in body but only conditions/actions are persisted in SQL bind
    expect(db.inserts[0].args[3]).toBeNull();
    expect(JSON.parse(db.inserts[0].args[4] as string)).toEqual(['notify']);
  });

  it('updates existing rule on conflict', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.ping', actions: JSON.stringify(['dont_notify']) })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.ping',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules).toHaveLength(1);
    expect(JSON.parse(db.rules[0].actions)).toEqual(['notify']);
  });

  it('sets priority from Date.now when before/after query params present', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/ordered?before=other',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].priority).toBe(1_234_567_890);

    const res2 = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/ordered2?after=x',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(res2.status).toBe(200);
    expect(db.rules[1].priority).toBe(1_234_567_890);
    vi.restoreAllMocks();
  });

  it('decodes URL-encoded rule id on create', async () => {
    const db = createPushDb();
    const id = 'rule/with spaces';
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(id)}`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].rule_id).toBe(id);
    expect(db.rules[0].kind).toBe('room');
  });
});

describe('push DELETE /_matrix/client/v3/pushrules/:scope/:kind/:ruleId', () => {
  it('rejects non-global scope', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/r1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('cannot delete default rules', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/.m.rule.master', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_DELETE_DEFAULT');
  });

  it('returns 404 when custom rule is missing', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/missing', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('deletes an existing custom rule', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'to.delete' }), seedRule({ rule_id: 'keep.me' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/to.delete', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.rules.map((r) => r.rule_id)).toEqual(['keep.me']);
  });

  it('deletes URL-encoded rule ids', async () => {
    const id = 'a/b c';
    const db = createPushDb({ rules: [seedRule({ rule_id: id })] });
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(db.rules).toHaveLength(0);
  });
});

// ============================================
// Push rules — enabled / actions
// ============================================

describe('push PUT .../enabled', () => {
  it('rejects bad JSON', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('requires boolean enabled', async () => {
    const db = createPushDb();
    for (const enabled of [undefined, 'yes', 1, null]) {
      const res = await request(
        db,
        '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
        jsonInit('PUT', { enabled })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('creates DB override when disabling a default rule', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0]).toMatchObject({
      rule_id: '.m.rule.master',
      kind: 'override',
      enabled: 1,
    });
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
  });

  it('updates enabled on existing default override via ON CONFLICT', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: '.m.rule.master',
          enabled: 1,
          actions: JSON.stringify(['dont_notify']),
          conditions: null,
        }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].enabled).toBe(0);
  });

  it('returns 404 for unknown default rule id', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.does_not_exist/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('updates custom (non-default) rule enabled flag', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.x', enabled: 1 })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.x/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].enabled).toBe(0);
    expect(db.updates.some((u) => u.sql.includes('UPDATE push_rules SET enabled'))).toBe(true);
  });

  it('can enable default underride and content rules', async () => {
    const db = createPushDb();
    const call = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.call/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(call.status).toBe(200);
    expect(db.rules[0].kind).toBe('underride');

    const content = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(content.status).toBe(200);
    expect(db.rules[1].kind).toBe('content');
  });

  it('persists conditions JSON when overriding default with conditions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.suppress_notices/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].conditions).toContain('m.notice');
  });
});

describe('push PUT .../actions', () => {
  it('rejects bad JSON', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.master/actions',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: 'nope',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('requires actions array', async () => {
    const db = createPushDb();
    for (const actions of [undefined, 'notify', { set_tweak: 'sound' }, null]) {
      const res = await request(
        db,
        '/_matrix/client/v3/pushrules/global/override/.m.rule.master/actions',
        jsonInit('PUT', { actions })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('updates actions for an existing custom rule and preserves conditions', async () => {
    const conditions = [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }];
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'custom.y',
          conditions: JSON.stringify(conditions),
          actions: JSON.stringify(['dont_notify']),
        }),
      ],
    });
    const newActions = ['notify', { set_tweak: 'highlight', value: true }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.y/actions',
      jsonInit('PUT', { actions: newActions })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.rules[0].actions)).toEqual(newActions);
    expect(JSON.parse(db.rules[0].conditions!)).toEqual(conditions);
  });

  it('tolerates bad conditions JSON on custom rule when setting actions', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.z', conditions: '{bad', actions: '[]' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/custom.z/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].conditions).toBeNull();
    expect(JSON.parse(db.rules[0].actions)).toEqual(['notify']);
  });

  it('creates override from default rule actions', async () => {
    const db = createPushDb();
    const actions = ['notify', { set_tweak: 'sound', value: 'default' }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.member_event/actions',
      jsonInit('PUT', { actions })
    );
    expect(res.status).toBe(200);
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0].rule_id).toBe('.m.rule.member_event');
    expect(JSON.parse(db.rules[0].actions)).toEqual(actions);
    expect(JSON.parse(db.rules[0].conditions!)).toEqual([
      { kind: 'event_match', key: 'type', pattern: 'm.room.member' },
    ]);
  });

  it('returns 404 for unknown default rule', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.nope/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('returns 404 for missing custom non-default rule', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/not.there/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('can set empty actions array', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'empty.actions' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/empty.actions/actions',
      jsonInit('PUT', { actions: [] })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.rules[0].actions)).toEqual([]);
  });

  it('sets actions on default content rule without conditions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name/actions',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].conditions).toBeNull();
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
  });
});

// ============================================
// Notifications
// ============================================

describe('push GET /_matrix/client/v3/notifications', () => {
  it('returns empty list with no next_token', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: [], next_token: undefined });
  });

  it('maps notification rows with event payload', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({
          id: 10,
          actions: JSON.stringify(['notify', { set_tweak: 'highlight', value: true }]),
          read: 1,
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({
      room_id: ROOM,
      read: true,
      ts: 1_700_000_000_000,
      actions: ['notify', { set_tweak: 'highlight', value: true }],
      event: {
        event_id: EVENT,
        type: 'm.room.message',
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
        room_id: ROOM,
        origin_server_ts: 1_700_000_000_000,
      },
    });
    // profile_tag is set to undefined in the handler and dropped by JSON serialization
    expect('profile_tag' in res.body.notifications[0]).toBe(false);
    expect(res.body.next_token).toBe('10');
  });

  it('filters only=highlight and applies from cursor', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, notification_type: 'notify', created_at: 100 }),
        seedNotification({
          id: 2,
          notification_type: 'highlight',
          created_at: 200,
          event_id: '$h2',
        }),
        seedNotification({
          id: 3,
          notification_type: 'highlight',
          created_at: 300,
          event_id: '$h3',
        }),
        seedNotification({
          id: 4,
          user_id: BOB,
          notification_type: 'highlight',
          created_at: 400,
        }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/notifications?only=highlight&from=1&limit=10',
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { event: { event_id: string } }) => n.event.event_id)).toEqual(
      ['$h3', '$h2']
    );
    // next_token is last row in result order (DESC by created_at) → id 2
    expect(res.body.next_token).toBe('2');
  });

  it('ignores non-numeric from and defaults limit to 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      seedNotification({ id: i + 1, created_at: 1000 + i, event_id: `$e${i + 1}` })
    );
    const db = createPushDb({ notifications: many });
    const res = await request(db, '/_matrix/client/v3/notifications?from=abc', authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(20);
  });

  it('caps limit at 100', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      seedNotification({ id: i + 1, created_at: i, event_id: `$e${i + 1}` })
    );
    const db = createPushDb({ notifications: many });
    const res = await request(db, '/_matrix/client/v3/notifications?limit=500', authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(100);
  });

  it('tolerates malformed event content and actions JSON', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({
          id: 7,
          content: '{bad',
          actions: 'not-array',
          event_type: null,
          sender: null,
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications[0].event.content).toEqual({});
    expect(res.body.notifications[0].actions).toEqual([]);
    expect(res.body.notifications[0].read).toBe(false);
  });

  it('treats from=0 as no cursor filter', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, created_at: 10 }),
        seedNotification({ id: 2, created_at: 20, event_id: '$e2' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications?from=0', authGet());
    expect(res.body.notifications).toHaveLength(2);
  });

  it('scopes notifications to the authenticated user only', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, user_id: USER, event_id: '$mine' }),
        seedNotification({ id: 2, user_id: BOB, event_id: '$theirs' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].event.event_id).toBe('$mine');
  });
});

// ============================================
// End-to-end flow + TOKENMAXX leftover edges
// ============================================

describe('push API TOKENMAXX integration leftovers after #100/#101', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers pusher → lists it → deletes it', async () => {
    const db = createPushDb();
    const create = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, profile_tag: 'flow' })
    );
    expect(create.status).toBe(200);

    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers).toHaveLength(1);
    expect(list.body.pushers[0].profile_tag).toBe('flow');

    const del = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        pushkey: VALID_PUSHER_BODY.pushkey,
        kind: null,
        app_id: VALID_PUSHER_BODY.app_id,
      })
    );
    expect(del.status).toBe(200);
    const list2 = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list2.body.pushers).toEqual([]);
  });

  it('creates custom rule → get → disable → change actions → delete', async () => {
    const db = createPushDb();
    const id = 'flow.rule';

    const put = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}`,
      jsonInit('PUT', {
        actions: ['notify'],
        conditions: [{ kind: 'event_match', key: 'content.body', pattern: 'ping' }],
      })
    );
    expect(put.status).toBe(200);

    const get1 = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}`,
      authGet()
    );
    expect(get1.body.enabled).toBe(true);
    expect(get1.body.actions).toEqual(['notify']);

    const disable = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}/enabled`,
      jsonInit('PUT', { enabled: false })
    );
    expect(disable.status).toBe(200);

    const get2 = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}`,
      authGet()
    );
    expect(get2.body.enabled).toBe(false);

    const actions = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}/actions`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(actions.status).toBe(200);

    const get3 = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}`,
      authGet()
    );
    expect(get3.body.actions).toEqual(['dont_notify']);

    const del = await request(db, `/_matrix/client/v3/pushrules/global/override/${id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(del.status).toBe(200);

    const get4 = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${id}`,
      authGet()
    );
    expect(get4.status).toBe(404);
  });

  it('lists all default rule ids expected by Matrix clients', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const overrideIds = res.body.override.map((r: { rule_id: string }) => r.rule_id);
    for (const id of [
      '.m.rule.master',
      '.m.rule.suppress_notices',
      '.m.rule.invite_for_me',
      '.m.rule.member_event',
      '.m.rule.is_user_mention',
      '.m.rule.contains_display_name',
      '.m.rule.is_room_mention',
      '.m.rule.tombstone',
      '.m.rule.room.server_acl',
      '.m.rule.reaction',
    ]) {
      expect(overrideIds).toContain(id);
    }
    const underrideIds = res.body.underride.map((r: { rule_id: string }) => r.rule_id);
    for (const id of [
      '.m.rule.call',
      '.m.rule.encrypted_room_one_to_one',
      '.m.rule.room_one_to_one',
      '.m.rule.message',
      '.m.rule.encrypted',
    ]) {
      expect(underrideIds).toContain(id);
    }
  });

  it('default .m.rule.is_room_mention and tombstone actions include highlight tweak', async () => {
    const db = createPushDb();
    const roomMention = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.is_room_mention',
      authGet()
    );
    expect(roomMention.body.actions).toEqual(
      expect.arrayContaining(['notify', { set_tweak: 'highlight', value: true }])
    );

    const tombstone = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.tombstone',
      authGet()
    );
    expect(tombstone.body.actions).toEqual(
      expect.arrayContaining([{ set_tweak: 'highlight', value: true }])
    );
  });

  it('server_acl default rule has empty actions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.room.server_acl',
      authGet()
    );
    expect(res.body.actions).toEqual([]);
  });

  it('priority ordering of custom rules is reflected in SELECT ORDER BY', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'low', priority: 10 }),
        seedRule({ rule_id: 'high', priority: 1 }),
      ],
    });
    await request(db, '/_matrix/client/v3/pushrules', authGet());
    const select = db.selects.find((s) => s.sql.includes('ORDER BY priority ASC'));
    expect(select).toBeDefined();
    // both appear; high (priority 1) should be processed first → unshift last among customs at front
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const customIds = res.body.global.override
      .filter((r: { default: boolean }) => !r.default)
      .map((r: { rule_id: string }) => r.rule_id);
    expect(customIds).toEqual(['low', 'high']);
  });

  it('notifications only=nonhighlight does not add highlight SQL filter', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, notification_type: 'notify' }),
        seedNotification({ id: 2, notification_type: 'highlight', event_id: '$h' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/notifications?only=something_else',
      authGet()
    );
    expect(res.body.notifications).toHaveLength(2);
    const select = db.selects.find((s) => s.sql.includes('FROM notification_queue'));
    expect(select!.sql).not.toContain("notification_type = 'highlight'");
  });

  it('pusher set logs registration (console)', async () => {
    const db = createPushDb();
    await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', VALID_PUSHER_BODY));
    expect(console.log).toHaveBeenCalled();
    const logged = (console.log as any).mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('[push]')
    );
    expect(logged).toBe(true);
  });

  it('room and sender kinds accept create without pattern', async () => {
    const db = createPushDb();
    const room = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(ROOM)}`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(room.status).toBe(200);

    const sender = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(sender.status).toBe(200);
    expect(db.rules.map((r) => r.kind).sort()).toEqual(['room', 'sender']);
  });

  it('GET specific rule for room/sender kinds after create', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ kind: 'room', rule_id: ROOM, conditions: null }),
        seedRule({ kind: 'sender', rule_id: BOB, conditions: null }),
      ],
    });
    const room = await request(
      db,
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(ROOM)}`,
      authGet()
    );
    expect(room.status).toBe(200);
    expect(room.body.rule_id).toBe(ROOM);

    const sender = await request(
      db,
      `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent(BOB)}`,
      authGet()
    );
    expect(sender.status).toBe(200);
    expect(sender.body.rule_id).toBe(BOB);
  });
});

// =============================================================================
// TOKENMAXX HEAVY leftovers after #124 — pushers/rules/notifications edge matrix
// =============================================================================

describe('pushers GET — falsy profile_tag + SQL bind + multi-row', () => {
  it('omits empty-string profile_tag because "" is falsy under || undefined', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ profile_tag: '' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.status).toBe(200);
    expect(res.body.pushers).toHaveLength(1);
    expect('profile_tag' in res.body.pushers[0]).toBe(false);
  });

  it('binds authenticated userId into pushers SELECT', async () => {
    const db = createPushDb({ pushers: [seedPusher()] });
    await request(db, '/_matrix/client/v3/pushers', authGet());
    const sel = db.selects.find((s) => s.sql.includes('FROM pushers'));
    expect(sel?.args).toEqual([USER]);
    expect(sel!.sql).toContain('enabled = 1');
  });

  it('returns many enabled pushers without collapsing by app_id', async () => {
    const db = createPushDb({
      pushers: Array.from({ length: 15 }, (_, i) =>
        seedPusher({
          pushkey: `pk-${i}`,
          app_id: i % 2 === 0 ? 'im.vector.app' : `app.${i}`,
          profile_tag: i % 3 === 0 ? null : `t${i}`,
        })
      ),
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.body.pushers).toHaveLength(15);
  });

  it('unicode pushkey / display names round-trip on list', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: '鍵🔑',
          app_display_name: 'エレメント',
          device_display_name: '東京スマホ',
          lang: 'ja',
          profile_tag: 'モバイル',
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.body.pushers[0]).toMatchObject({
      pushkey: '鍵🔑',
      app_display_name: 'エレメント',
      device_display_name: '東京スマホ',
      lang: 'ja',
      profile_tag: 'モバイル',
    });
  });

  it('maps kind other than http (email / null-looking strings)', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'a', kind: 'email' }),
        seedPusher({ pushkey: 'b', app_id: 'x', kind: 'http' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.body.pushers.map((p: { kind: string }) => p.kind).sort()).toEqual([
      'email',
      'http',
    ]);
  });
});

describe('pushers SET — falsy required fields + delete isolation + append matrix', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects empty-string pushkey as missing', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: '' })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it.each([
    ['app_id', { ...VALID_PUSHER_BODY, app_id: '' }],
    ['app_display_name', { ...VALID_PUSHER_BODY, app_display_name: '' }],
    ['device_display_name', { ...VALID_PUSHER_BODY, device_display_name: '' }],
    ['lang', { ...VALID_PUSHER_BODY, lang: '' }],
    ['data null', { ...VALID_PUSHER_BODY, data: null }],
    ['data undefined omitted', { ...VALID_PUSHER_BODY, data: undefined }],
  ])('rejects falsy create field: %s', async (_label, body) => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('accepts empty-object data (truthy) and stringifies it', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, data: {} })
    );
    expect(res.status).toBe(200);
    expect(db.pushers[0].data).toBe('{}');
  });

  it('stores empty-string profile_tag as null via || null', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, profile_tag: '' })
    );
    expect(db.pushers[0].profile_tag).toBeNull();
  });

  it('treats kind empty-string as create (not delete) because "" is not null/undefined', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, kind: '' })
    );
    expect(res.status).toBe(200);
    expect(db.pushers[0].kind).toBe('');
  });

  it('delete with mismatched app_id leaves the pusher in place', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-keep', app_id: 'im.vector.app' })],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-keep', kind: null, app_id: 'other.app' })
    );
    expect(res.status).toBe(200);
    expect(db.pushers).toHaveLength(1);
    const del = db.deletes.find((d) => d.sql.includes('app_id = ?'));
    expect(del?.args).toEqual([USER, 'pk-keep', 'other.app']);
  });

  it('delete binds empty app_id when omitted on kind:null', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-x', app_id: '' })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-x', kind: null })
    );
    expect(db.pushers).toHaveLength(0);
    expect(db.deletes[0].args).toEqual([USER, 'pk-x', '']);
  });

  it('append:false deletes same pushkey across app_ids then inserts', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({ pushkey: 'shared', app_id: 'a1' }),
        seedPusher({ pushkey: 'shared', app_id: 'a2' }),
        seedPusher({ pushkey: 'other', app_id: 'a1' }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        pushkey: 'shared',
        app_id: 'a3',
        append: false,
      })
    );
    expect(db.pushers.map((p) => `${p.pushkey}:${p.app_id}`).sort()).toEqual([
      'other:a1',
      'shared:a3',
    ]);
  });

  it('append truthiness: append:0 still deletes same pushkey (falsy)', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-new', app_id: 'old.app' })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, append: 0 as unknown as boolean })
    );
    expect(db.pushers).toHaveLength(1);
    expect(db.pushers[0].app_id).toBe(VALID_PUSHER_BODY.app_id);
  });

  it('append:true keeps different app_id same pushkey and adds another', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-new', app_id: 'legacy.app' })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, append: true })
    );
    expect(db.pushers).toHaveLength(2);
  });

  it('upsert ON CONFLICT updates fields for same user/pushkey/app_id', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: VALID_PUSHER_BODY.pushkey,
          app_id: VALID_PUSHER_BODY.app_id,
          lang: 'en',
          device_display_name: 'Old',
        }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        append: true,
        lang: 'de',
        device_display_name: 'Neu',
        data: { url: 'https://de.example/notify' },
      })
    );
    expect(db.pushers).toHaveLength(1);
    expect(db.pushers[0]).toMatchObject({
      lang: 'de',
      device_display_name: 'Neu',
      data: JSON.stringify({ url: 'https://de.example/notify' }),
    });
  });

  it('INSERT bind order is user_id…data contract', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, profile_tag: 'pt' })
    );
    const ins = db.inserts.find((i) => i.sql.includes('INSERT INTO pushers'));
    expect(ins?.args).toEqual([
      USER,
      VALID_PUSHER_BODY.pushkey,
      VALID_PUSHER_BODY.kind,
      VALID_PUSHER_BODY.app_id,
      VALID_PUSHER_BODY.app_display_name,
      VALID_PUSHER_BODY.device_display_name,
      'pt',
      VALID_PUSHER_BODY.lang,
      JSON.stringify(VALID_PUSHER_BODY.data),
    ]);
  });

  it('extra unknown body fields are ignored on create', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER_BODY,
        device_id: 'SHOULD_IGNORE',
        enabled: false,
        extra: { nested: 1 },
      })
    );
    expect(res.status).toBe(200);
    expect(db.pushers[0].enabled).toBe(1);
  });

  it('array JSON body is not a valid pusher shape → missing pushkey', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', []));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
});

describe('pushrules defaults — personalization + condition shape leftovers', () => {
  it('invite_for_me / is_user_mention / contains_user_name use auth localpart/userId', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const invite = res.body.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.invite_for_me'
    );
    expect(invite.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'state_key', pattern: USER }),
        expect.objectContaining({ key: 'content.membership', pattern: 'invite' }),
      ])
    );

    const mention = res.body.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.is_user_mention'
    );
    expect(mention.conditions[0]).toMatchObject({
      kind: 'event_property_contains',
      value: USER,
    });

    const content = res.body.content.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.contains_user_name'
    );
    expect(content.pattern).toBe('alice');
    expect(content.default).toBe(true);
  });

  it('master default is disabled; reaction uses dont_notify; call uses ring', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const master = res.body.global.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.master'
    );
    expect(master.enabled).toBe(false);
    expect(master.actions).toEqual(['dont_notify']);

    const reaction = res.body.global.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.reaction'
    );
    expect(reaction.actions).toEqual(['dont_notify']);

    const call = res.body.global.underride.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.call'
    );
    expect(call.actions).toEqual(
      expect.arrayContaining(['notify', { set_tweak: 'sound', value: 'ring' }])
    );
  });

  it('one-to-one underride rules include room_member_count is:2', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    for (const id of ['.m.rule.room_one_to_one', '.m.rule.encrypted_room_one_to_one']) {
      const rule = res.body.underride.find((r: { rule_id: string }) => r.rule_id === id);
      expect(rule.conditions).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'room_member_count', is: '2' })])
      );
    }
  });

  it('GET /pushrules and /pushrules/ and /pushrules/global agree on override count', async () => {
    const db = createPushDb();
    const a = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const b = await request(db, '/_matrix/client/v3/pushrules/', authGet());
    const c = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(a.body.global.override).toHaveLength(c.body.override.length);
    expect(b.body.global.override).toHaveLength(c.body.override.length);
    expect(a.body.global.content[0].pattern).toBe(c.body.content[0].pattern);
  });

  it('custom rules for other users never appear in alice list', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ user_id: BOB, rule_id: 'bob.only', kind: 'override' }),
        seedRule({ user_id: USER, rule_id: 'alice.only', kind: 'override' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const custom = res.body.global.override.filter((r: { default: boolean }) => !r.default);
    expect(custom.map((r: { rule_id: string }) => r.rule_id)).toEqual(['alice.only']);
  });

  it('disabled custom rule still listed with enabled:false', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'quiet', enabled: 0 })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const quiet = res.body.override.find((r: { rule_id: string }) => r.rule_id === 'quiet');
    expect(quiet.enabled).toBe(false);
    expect(quiet.default).toBe(false);
  });

  it('custom rule whose id starts with .m.rule. is marked default:true on merge', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: '.m.rule.master',
          enabled: 0,
          actions: JSON.stringify(['notify']),
          conditions: null,
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const master = res.body.override.find(
      (r: { rule_id: string }) => r.rule_id === '.m.rule.master'
    );
    expect(master.default).toBe(true);
    expect(master.enabled).toBe(false);
    expect(master.actions).toEqual(['notify']);
  });
});

describe('pushrules GET :scope/:kind/:ruleId — kind vocab + decode leftovers', () => {
  it.each(['device', 'DEVICE', 'Global', 'GLOBAL', 'room'])(
    'rejects non-global scope %j',
    async (scope) => {
      const db = createPushDb();
      const res = await request(
        db,
        `/_matrix/client/v3/pushrules/${scope}/override/x`,
        authGet()
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_INVALID_PARAM');
    }
  );

  it.each(['override', 'content', 'room', 'sender', 'underride'])(
    'accepts kind %s and 404s missing rule',
    async (kind) => {
      const db = createPushDb();
      const res = await request(
        db,
        `/_matrix/client/v3/pushrules/global/${kind}/no.such.rule`,
        authGet()
      );
      expect(res.status).toBe(404);
      expect(res.body.errcode).toBe('M_NOT_FOUND');
    }
  );

  it('rejects kind not in global map', async () => {
    const db = createPushDb();
    for (const kind of ['unknown', 'device', 'org.custom', 'OVERRIDE']) {
      const res = await request(
        db,
        `/_matrix/client/v3/pushrules/global/${kind}/x`,
        authGet()
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_INVALID_PARAM');
      expect(res.body.error).toContain(kind);
    }
  });

  it('returns every default override by id', async () => {
    const db = createPushDb();
    const ids = [
      '.m.rule.master',
      '.m.rule.suppress_notices',
      '.m.rule.invite_for_me',
      '.m.rule.member_event',
      '.m.rule.is_user_mention',
      '.m.rule.contains_display_name',
      '.m.rule.is_room_mention',
      '.m.rule.tombstone',
      '.m.rule.room.server_acl',
      '.m.rule.reaction',
    ];
    for (const id of ids) {
      const res = await request(
        db,
        `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
        authGet()
      );
      expect(res.status).toBe(200);
      expect(res.body.rule_id).toBe(id);
      expect(res.body.default).toBe(true);
    }
  });

  it('decodes double-encoded-looking rule ids once via decodeURIComponent', async () => {
    const id = 'rule with spaces';
    const db = createPushDb({
      rules: [seedRule({ rule_id: id, kind: 'override' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body.rule_id).toBe(id);
  });

  it('GET underride default .m.rule.message', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.message',
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual(['notify']);
  });
});

describe('pushrules PUT create — kinds / pattern / conditions / priority leftovers', () => {
  it('rejects content kind with empty-string pattern as missing', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/kw',
      jsonInit('PUT', { actions: ['notify'], pattern: '' })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('creates underride custom rule with conditions', async () => {
    const db = createPushDb();
    const conditions = [{ kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' }];
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/custom.enc',
      jsonInit('PUT', { actions: ['notify'], conditions })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0]).toMatchObject({
      kind: 'underride',
      rule_id: 'custom.enc',
      conditions: JSON.stringify(conditions),
      actions: JSON.stringify(['notify']),
      priority: 0,
    });
  });

  it('creates room and sender rules with MXID/room id as rule_id', async () => {
    const db = createPushDb();
    const roomId = '!Quiet:example.com';
    const sender = '@spammer:example.com';
    expect(
      (
        await request(
          db,
          `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(roomId)}`,
          jsonInit('PUT', { actions: ['dont_notify'] })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          db,
          `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent(sender)}`,
          jsonInit('PUT', { actions: ['dont_notify'] })
        )
      ).status
    ).toBe(200);
    expect(db.rules.map((r) => r.rule_id).sort()).toEqual([roomId, sender].sort());
  });

  it('persists empty conditions array as JSON "[]"', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/empty.cond',
      jsonInit('PUT', { actions: ['notify'], conditions: [] })
    );
    expect(db.rules[0].conditions).toBe('[]');
  });

  it('persists complex set_tweak action objects', async () => {
    const db = createPushDb();
    const actions = [
      'notify',
      { set_tweak: 'sound', value: 'default' },
      { set_tweak: 'highlight', value: true },
    ];
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/tweaks',
      jsonInit('PUT', { actions })
    );
    expect(JSON.parse(db.rules[0].actions)).toEqual(actions);
  });

  it('cannot overwrite default even when URL-encoded', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent('.m.rule.master')}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_OVERWRITE_DEFAULT');
  });

  it('before=x alone and after=y alone both set priority to Date.now()', async () => {
    const db = createPushDb();
    const t0 = Date.now();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/p1?before=other',
      jsonInit('PUT', { actions: ['notify'] })
    );
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/p2?after=other',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    const t1 = Date.now();
    expect(db.rules.find((r) => r.rule_id === 'p1')!.priority).toBeGreaterThanOrEqual(t0);
    expect(db.rules.find((r) => r.rule_id === 'p2')!.priority).toBeLessThanOrEqual(t1);
  });

  it('empty before=/after= query values are falsy → priority stays 0', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/empty.q?before=&after=',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(db.rules[0].priority).toBe(0);
  });

  it('without before/after query, priority stays 0', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/plain',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(db.rules[0].priority).toBe(0);
  });

  it('ON CONFLICT updates conditions/actions/priority and keeps enabled', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'upd',
          enabled: 0,
          priority: 5,
          actions: JSON.stringify(['dont_notify']),
        }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/upd?before=x',
      jsonInit('PUT', {
        actions: ['notify'],
        conditions: [{ kind: 'contains_display_name' }],
      })
    );
    const row = db.rules.find((r) => r.rule_id === 'upd')!;
    expect(row.enabled).toBe(0); // UPDATE SET does not touch enabled
    expect(JSON.parse(row.actions)).toEqual(['notify']);
    expect(JSON.parse(row.conditions!)).toEqual([{ kind: 'contains_display_name' }]);
    expect(row.priority).toBeGreaterThan(5);
  });

  it('PUT bind contract includes userId/kind/ruleId/conditions/actions/priority', async () => {
    const db = createPushDb();
    const conditions = [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }];
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/bind.me',
      jsonInit('PUT', { actions: ['notify'], conditions })
    );
    const ins = db.inserts.find((i) => i.sql.includes('INSERT INTO push_rules'));
    expect(ins?.args[0]).toBe(USER);
    expect(ins?.args[1]).toBe('override');
    expect(ins?.args[2]).toBe('bind.me');
    expect(ins?.args[3]).toBe(JSON.stringify(conditions));
    expect(ins?.args[4]).toBe(JSON.stringify(['notify']));
    expect(ins?.args[5]).toBe(0);
  });

  it('content rule stores conditions null even when pattern provided', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/keyword',
      jsonInit('PUT', { actions: ['notify'], pattern: 'hello*' })
    );
    expect(db.rules[0].conditions).toBeNull();
    // pattern is not a DB column — only validated then dropped from SQL
    const get = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/keyword',
      authGet()
    );
    // merged rule from DB has no pattern field unless conditions encode it
    expect(get.body.pattern).toBeUndefined();
    expect(get.body.actions).toEqual(['notify']);
  });

  it('rejects actions:null / actions:0 / actions:false as missing', async () => {
    const db = createPushDb();
    for (const actions of [null, 0, false, '']) {
      const res = await request(
        db,
        '/_matrix/client/v3/pushrules/global/override/a',
        jsonInit('PUT', { actions })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('accepts empty actions array on create (truthy array)', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/silent',
      jsonInit('PUT', { actions: [] })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].actions).toBe('[]');
  });
});

describe('pushrules DELETE — kind matrix + isolation leftovers', () => {
  it('cannot delete URL-encoded default rule', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent('.m.rule.reaction')}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_CANNOT_DELETE_DEFAULT');
  });

  it.each(['override', 'content', 'room', 'sender', 'underride'] as const)(
    'deletes custom %s rule and binds [userId, kind, ruleId]',
    async (kind) => {
      const id = kind === 'room' ? ROOM : kind === 'sender' ? BOB : `del.${kind}`;
      const db = createPushDb({
        rules: [seedRule({ kind, rule_id: id, conditions: null })],
      });
      const res = await request(
        db,
        `/_matrix/client/v3/pushrules/global/${kind}/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
      );
      expect(res.status).toBe(200);
      expect(db.rules).toHaveLength(0);
      expect(db.deletes[0].args).toEqual([USER, kind, id]);
    }
  );

  it('404 when rule exists only for another user', async () => {
    const db = createPushDb({
      rules: [seedRule({ user_id: BOB, rule_id: 'shared.name' })],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global/override/shared.name', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
    expect(db.rules).toHaveLength(1);
  });

  it('rejects non-global scope on DELETE', async () => {
    const db = createPushDb();
    const res = await request(db, '/_matrix/client/v3/pushrules/device/override/x', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });
});

describe('pushrules enabled — custom missing + default kinds leftovers', () => {
  it('enabling missing custom rule still returns {} (UPDATE changes=0)', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/ghost/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].args).toEqual([1, USER, 'override', 'ghost']);
    expect(db.rules).toHaveLength(0);
  });

  it('rejects enabled as string/number/null', async () => {
    const db = createPushDb();
    for (const enabled of ['true', 'false', 1, 0, null, 'yes']) {
      const res = await request(
        db,
        '/_matrix/client/v3/pushrules/global/override/.m.rule.master/enabled',
        jsonInit('PUT', { enabled })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('can toggle default rules across override/content/underride kinds', async () => {
    const db = createPushDb();
    const cases = [
      ['override', '.m.rule.master'],
      ['content', '.m.rule.contains_user_name'],
      ['underride', '.m.rule.call'],
    ] as const;
    for (const [kind, id] of cases) {
      const res = await request(
        db,
        `/_matrix/client/v3/pushrules/global/${kind}/${encodeURIComponent(id)}/enabled`,
        jsonInit('PUT', { enabled: false })
      );
      expect(res.status).toBe(200);
    }
    expect(db.rules).toHaveLength(3);
    expect(db.rules.every((r) => r.enabled === 0)).toBe(true);
  });

  it('404 when default rule id unknown for kind', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.not_a_real_default/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(res.status).toBe(404);
  });

  it('re-enable default after disable uses ON CONFLICT enabled update', async () => {
    const db = createPushDb();
    const path =
      '/_matrix/client/v3/pushrules/global/override/.m.rule.suppress_notices/enabled';
    await request(db, path, jsonInit('PUT', { enabled: false }));
    await request(db, path, jsonInit('PUT', { enabled: true }));
    const row = db.rules.find((r) => r.rule_id === '.m.rule.suppress_notices')!;
    expect(row.enabled).toBe(1);
    expect(db.rules.filter((r) => r.rule_id === '.m.rule.suppress_notices')).toHaveLength(1);
  });

  it('custom rule enabled toggle binds [enabled, userId, kind, ruleId]', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c1' })] });
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/c1/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(db.updates[0].args).toEqual([0, USER, 'override', 'c1']);
    expect(db.rules[0].enabled).toBe(0);
  });

  it('scope param is ignored on enabled endpoint (device scope still works)', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'c2' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/device/override/c2/enabled',
      jsonInit('PUT', { enabled: false })
    );
    expect(res.status).toBe(200);
    expect(db.rules[0].enabled).toBe(0);
  });
});

describe('pushrules actions — upsert edges leftovers', () => {
  it('sets actions on default underride and preserves default conditions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/underride/.m.rule.message/actions',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(res.status).toBe(200);
    const row = db.rules[0];
    expect(JSON.parse(row.actions)).toEqual(['dont_notify']);
    expect(JSON.parse(row.conditions!)).toEqual([
      { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
    ]);
  });

  it('404 for unknown default on actions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.nope/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(404);
  });

  it('404 for missing custom non-default on actions', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/room/!missing:example.com/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(404);
  });

  it('ON CONFLICT actions-only upsert does not change priority', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'prio', priority: 99, actions: JSON.stringify(['notify']) })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/prio/actions',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(db.rules[0].priority).toBe(99);
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
  });

  it('accepts nested set_tweak objects and empty array', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'nest' })] });
    const actions = [{ set_tweak: 'sound', value: 'custom' }, { set_tweak: 'highlight' }];
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/nest/actions',
      jsonInit('PUT', { actions })
    );
    expect(JSON.parse(db.rules[0].actions)).toEqual(actions);

    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/nest/actions',
      jsonInit('PUT', { actions: [] })
    );
    expect(db.rules[0].actions).toBe('[]');
  });

  it('scope ignored on actions endpoint like enabled', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 's' })] });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/device/override/s/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(res.status).toBe(200);
  });

  it('actions bind preserves prior conditions JSON from custom rule', async () => {
    const conditions = [{ kind: 'event_match', key: 'content.body', pattern: 'x' }];
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'keep.cond',
          conditions: JSON.stringify(conditions),
        }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/keep.cond/actions',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    const ins = db.inserts.find((i) =>
      i.sql.includes('actions = excluded.actions')
    );
    expect(ins?.args[3]).toBe(JSON.stringify(conditions));
  });
});

describe('notifications GET — limit/from/only/shape leftovers', () => {
  it('limit=0 yields empty list but still may omit next_token', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications?limit=0', authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.next_token).toBeUndefined();
  });

  it('negative limit is passed through Math.min and may yield empty', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 1 }), seedNotification({ id: 2, event_id: '$e2' })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications?limit=-5', authGet());
    expect(res.status).toBe(200);
    // Math.min(-5, 100) === -5; Array#slice(0, -5) drops from end → empty for short arrays
    expect(res.body.notifications).toEqual([]);
  });

  it('NaN limit from limit=abc uses Math.min(NaN,100)=NaN → slice yields []', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 1 })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications?limit=abc', authGet());
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
  });

  it('from cursor with no matching ids returns empty without next_token', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 5 })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications?from=99', authGet());
    expect(res.body.notifications).toEqual([]);
    expect(res.body.next_token).toBeUndefined();
  });

  it('single notification sets next_token to its id string', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 42 })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.next_token).toBe('42');
  });

  it('null content becomes {} and read:0 → false', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({
          id: 3,
          content: null,
          read: 0,
          actions: JSON.stringify(['notify']),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.notifications[0].event.content).toEqual({});
    expect(res.body.notifications[0].read).toBe(false);
  });

  it('orders by created_at DESC independent of id order', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 10, created_at: 100, event_id: '$old' }),
        seedNotification({ id: 11, created_at: 300, event_id: '$new' }),
        seedNotification({ id: 12, created_at: 200, event_id: '$mid' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.notifications.map((n: { event: { event_id: string } }) => n.event.event_id)).toEqual(
      ['$new', '$mid', '$old']
    );
    // next_token is last in result order → oldest among page
    expect(res.body.next_token).toBe('10');
  });

  it('binds userId and limit into notification SELECT', async () => {
    const db = createPushDb();
    await request(db, '/_matrix/client/v3/notifications?limit=7', authGet());
    const sel = db.selects.find((s) => s.sql.includes('notification_queue'));
    expect(sel?.args[0]).toBe(USER);
    expect(sel?.args[sel.args.length - 1]).toBe(7);
  });

  it('from + only=highlight bind both filters', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, notification_type: 'highlight', created_at: 1 }),
        seedNotification({
          id: 2,
          notification_type: 'highlight',
          created_at: 2,
          event_id: '$h2',
        }),
      ],
    });
    await request(
      db,
      '/_matrix/client/v3/notifications?from=1&only=highlight&limit=10',
      authGet()
    );
    const sel = db.selects.find((s) => s.sql.includes('notification_queue'));
    expect(sel!.sql).toContain('nq.id > ?');
    expect(sel!.sql).toContain("notification_type = 'highlight'");
    expect(sel?.args).toEqual([USER, 1, 10]);
  });

  it('limit exactly 100 is not capped further', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      seedNotification({ id: i + 1, created_at: i, event_id: `$e${i}` })
    );
    const db = createPushDb({ notifications: many });
    const res = await request(db, '/_matrix/client/v3/notifications?limit=100', authGet());
    expect(res.body.notifications).toHaveLength(100);
  });

  it('event fields may be null when LEFT JOIN misses', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({
          id: 1,
          event_type: null,
          sender: null,
          content: null,
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.notifications[0].event).toMatchObject({
      event_id: EVENT,
      type: null,
      sender: null,
      content: {},
      room_id: ROOM,
    });
  });
});

describe('push API TOKENMAXX lifecycles — room/sender/content/underride', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('room mute lifecycle: put → get → actions → enabled → delete', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(ROOM)}`;
    expect((await request(db, path, jsonInit('PUT', { actions: ['dont_notify'] }))).status).toBe(
      200
    );
    expect((await request(db, path, authGet())).body.actions).toEqual(['dont_notify']);
    expect(
      (await request(db, `${path}/actions`, jsonInit('PUT', { actions: ['notify'] }))).status
    ).toBe(200);
    expect((await request(db, path, authGet())).body.actions).toEqual(['notify']);
    expect(
      (await request(db, `${path}/enabled`, jsonInit('PUT', { enabled: false }))).status
    ).toBe(200);
    expect((await request(db, path, authGet())).body.enabled).toBe(false);
    expect(
      (await request(db, path, { method: 'DELETE', headers: { Authorization: 'Bearer t' } }))
        .status
    ).toBe(200);
    expect((await request(db, path, authGet())).status).toBe(404);
  });

  it('sender mute lifecycle mirrors room', async () => {
    const db = createPushDb();
    const path = `/_matrix/client/v3/pushrules/global/sender/${encodeURIComponent(BOB)}`;
    await request(db, path, jsonInit('PUT', { actions: ['dont_notify'] }));
    await request(db, `${path}/enabled`, jsonInit('PUT', { enabled: false }));
    const get = await request(db, path, authGet());
    expect(get.body).toMatchObject({ rule_id: BOB, enabled: false, default: false });
    await request(db, path, { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
    expect(db.rules).toHaveLength(0);
  });

  it('content keyword create → list prepend → delete', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/kw.alert',
      jsonInit('PUT', { actions: ['notify'], pattern: 'urgent' })
    );
    const list = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(list.body.content[0].rule_id).toBe('kw.alert');
    expect(list.body.content.some((r: { rule_id: string }) => r.rule_id === '.m.rule.contains_user_name')).toBe(
      true
    );
    await request(db, '/_matrix/client/v3/pushrules/global/content/kw.alert', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    const list2 = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(list2.body.content).toHaveLength(1);
    expect(list2.body.content[0].rule_id).toBe('.m.rule.contains_user_name');
  });

  it('dense custom override stress under merge (unshift order)', async () => {
    const db = createPushDb();
    for (let i = 0; i < 20; i++) {
      await request(
        db,
        `/_matrix/client/v3/pushrules/global/override/bulk.${i}`,
        jsonInit('PUT', {
          actions: ['notify'],
          conditions: [{ kind: 'event_match', key: 'content.body', pattern: `p${i}` }],
        })
      );
    }
    expect(db.rules).toHaveLength(20);
    const list = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const customs = list.body.global.override.filter((r: { default: boolean }) => !r.default);
    expect(customs).toHaveLength(20);
    // priority all 0; ASC order then unshift → last processed ends near front
    expect(customs[0].rule_id).toBe('bulk.19');
  });

  it('pusher register → upsert lang → list → delete wrong app no-op → delete correct', async () => {
    const db = createPushDb();
    await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', VALID_PUSHER_BODY));
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, append: true, lang: 'es' })
    );
    expect(db.pushers[0].lang).toBe('es');
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers).toHaveLength(1);
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        pushkey: VALID_PUSHER_BODY.pushkey,
        kind: null,
        app_id: 'wrong',
      })
    );
    expect(db.pushers).toHaveLength(1);
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        pushkey: VALID_PUSHER_BODY.pushkey,
        kind: null,
        app_id: VALID_PUSHER_BODY.app_id,
      })
    );
    expect(db.pushers).toHaveLength(0);
  });

  it('default disable → list reflects → actions override → get merged', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.reaction/enabled',
      jsonInit('PUT', { enabled: false })
    );
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.reaction/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    const get = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.reaction',
      authGet()
    );
    expect(get.body.enabled).toBe(false);
    expect(get.body.actions).toEqual(['notify']);
    expect(get.body.default).toBe(true);
  });

  it('errcode vocabulary across push routes', async () => {
    const db = createPushDb();
    const cases: Array<{ path: string; init: RequestInit; code: string }> = [
      {
        path: '/_matrix/client/v3/pushers/set',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: '{',
        },
        code: 'M_BAD_JSON',
      },
      {
        path: '/_matrix/client/v3/pushers/set',
        init: jsonInit('POST', { kind: 'http' }),
        code: 'M_MISSING_PARAM',
      },
      {
        path: '/_matrix/client/v3/pushrules/device/override/x',
        init: authGet(),
        code: 'M_INVALID_PARAM',
      },
      {
        path: '/_matrix/client/v3/pushrules/global/override/.m.rule.master',
        init: jsonInit('PUT', { actions: ['notify'] }),
        code: 'M_CANNOT_OVERWRITE_DEFAULT',
      },
      {
        path: '/_matrix/client/v3/pushrules/global/override/.m.rule.master',
        init: { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        code: 'M_CANNOT_DELETE_DEFAULT',
      },
      {
        path: '/_matrix/client/v3/pushrules/global/override/missing',
        init: authGet(),
        code: 'M_NOT_FOUND',
      },
    ];
    for (const c of cases) {
      const res = await request(db, c.path, c.init);
      expect(res.body.errcode).toBe(c.code);
    }
  });
});

// =============================================================================
// TOKENMAXX HEAVY leftovers flood — SQL contracts + response shape + multi-kind
// =============================================================================

describe('pushers response shape — field completeness leftovers', () => {
  it('lists all Matrix pusher fields for a full row', async () => {
    const db = createPushDb({
      pushers: [
        seedPusher({
          pushkey: 'full-key',
          kind: 'http',
          app_id: 'im.vector.app',
          app_display_name: 'Element',
          device_display_name: 'iPhone',
          profile_tag: 'tag',
          lang: 'en-US',
          data: JSON.stringify({
            url: 'https://push.example.com/_matrix/push/v1/notify',
            format: 'event_id_only',
          }),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(Object.keys(res.body.pushers[0]).sort()).toEqual(
      [
        'app_display_name',
        'app_id',
        'data',
        'device_display_name',
        'kind',
        'lang',
        'profile_tag',
        'pushkey',
      ].sort()
    );
  });

  it('does not leak enabled column or user_id into list response', async () => {
    const db = createPushDb({ pushers: [seedPusher()] });
    const res = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(res.body.pushers[0].enabled).toBeUndefined();
    expect(res.body.pushers[0].user_id).toBeUndefined();
  });
});

describe('pushers SET — kind null vs undefined vs missing vocabulary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kind:undefined via JSON omit deletes (undefined after destructure)', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'k1', app_id: 'app.a' })],
    });
    // JSON.stringify omits undefined → body has no kind → undefined → delete path
    const body = { pushkey: 'k1', app_id: 'app.a' };
    const res = await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', body));
    expect(res.status).toBe(200);
    expect(db.pushers).toHaveLength(0);
  });

  it('kind:null explicitly deletes', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'k2', app_id: 'app.a' })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'k2', kind: null, app_id: 'app.a' })
    );
    expect(db.pushers).toHaveLength(0);
  });

  it('rejects pushkey:null / pushkey:0 / pushkey:false', async () => {
    const db = createPushDb();
    for (const pushkey of [null, 0, false]) {
      const res = await request(
        db,
        '/_matrix/client/v3/pushers/set',
        jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('accepts numeric-looking string pushkey', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: '0' })
    );
    expect(res.status).toBe(200);
    expect(db.pushers[0].pushkey).toBe('0');
  });

  it('data as nested array/object stringifies stably', async () => {
    const db = createPushDb();
    const data = { url: 'https://x', format: 'event_id_only', tags: ['a', 'b'], meta: { n: 1 } };
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, data })
    );
    expect(JSON.parse(db.pushers[0].data)).toEqual(data);
    const list = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(list.body.pushers[0].data).toEqual(data);
  });

  it('long pushkey and display names are stored verbatim', async () => {
    const db = createPushDb();
    const pushkey = `pk-${'x'.repeat(500)}`;
    const app_display_name = `App-${'名'.repeat(100)}`;
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey, app_display_name })
    );
    expect(db.pushers[0].pushkey).toBe(pushkey);
    expect(db.pushers[0].app_display_name).toBe(app_display_name);
  });
});

describe('pushrules merge — priority ASC unshift + kind buckets leftovers', () => {
  it('same priority customs: ASC stable then unshift reverses processing order at front', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'a', priority: 0 }),
        seedRule({ rule_id: 'b', priority: 0 }),
        seedRule({ rule_id: 'c', priority: 0 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const customs = res.body.override
      .filter((r: { default: boolean }) => !r.default)
      .map((r: { rule_id: string }) => r.rule_id);
    // processed a,b,c in ASC (stable insert order) with unshift → c,b,a at front
    expect(customs).toEqual(['c', 'b', 'a']);
  });

  it('lower priority number processed first → ends further back after later unshifts', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ rule_id: 'first', priority: 1 }),
        seedRule({ rule_id: 'second', priority: 2 }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules', authGet());
    const customs = res.body.global.override
      .filter((r: { default: boolean }) => !r.default)
      .map((r: { rule_id: string }) => r.rule_id);
    expect(customs).toEqual(['second', 'first']);
  });

  it('unknown kind in DB is ignored (kindRules falsy)', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ kind: 'not_a_kind', rule_id: 'ghost' }),
        seedRule({ kind: 'override', rule_id: 'real' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    const allIds = [
      ...res.body.override,
      ...res.body.content,
      ...res.body.room,
      ...res.body.sender,
      ...res.body.underride,
    ].map((r: { rule_id: string }) => r.rule_id);
    expect(allIds).toContain('real');
    expect(allIds).not.toContain('ghost');
  });

  it('malformed actions JSON becomes [] on merge; malformed conditions become undefined', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'bad.json',
          actions: '{nope',
          conditions: 'also-bad',
        }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/bad.json',
      authGet()
    );
    expect(res.body.actions).toEqual([]);
    expect(res.body.conditions).toBeUndefined();
  });

  it('content custom prepends ahead of default contains_user_name', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          kind: 'content',
          rule_id: 'custom.kw',
          conditions: null,
          actions: JSON.stringify(['notify']),
        }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.body.content[0].rule_id).toBe('custom.kw');
    expect(res.body.content[1].rule_id).toBe('.m.rule.contains_user_name');
  });

  it('room/sender buckets start empty and only hold customs', async () => {
    const db = createPushDb({
      rules: [
        seedRule({ kind: 'room', rule_id: ROOM, conditions: null }),
        seedRule({ kind: 'sender', rule_id: BOB, conditions: null }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(res.body.room).toHaveLength(1);
    expect(res.body.sender).toHaveLength(1);
    expect(res.body.room[0].default).toBe(false);
    expect(res.body.sender[0].default).toBe(false);
  });
});

describe('pushrules PUT/DELETE — percent-encoding + dot-prefix edges', () => {
  it('rule ids with slash encoded are stored decoded', async () => {
    const id = 'a/b';
    const db = createPushDb();
    await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(db.rules[0].rule_id).toBe('a/b');
    const get = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      authGet()
    );
    expect(get.body.rule_id).toBe('a/b');
  });

  it('rule id starting with dot but not .m.rule. can be created and deleted', async () => {
    const db = createPushDb();
    const id = '.custom.not.default';
    expect(
      (
        await request(
          db,
          `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
          jsonInit('PUT', { actions: ['notify'] })
        )
      ).status
    ).toBe(200);
    const get = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      authGet()
    );
    expect(get.body.default).toBe(false);
    const del = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(del.status).toBe(200);
  });

  it('id .m.rule.evil can neither be PUT nor DELETE (prefix guard)', async () => {
    const db = createPushDb();
    const id = '.m.rule.evil';
    const put = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(put.body.errcode).toBe('M_CANNOT_OVERWRITE_DEFAULT');
    const del = await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(del.body.errcode).toBe('M_CANNOT_DELETE_DEFAULT');
  });

  it('content kind without pattern rejected; with pattern accepted for unicode keyword', async () => {
    const db = createPushDb();
    const miss = await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/日本語',
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(miss.status).toBe(400);
    const ok = await request(
      db,
      `/_matrix/client/v3/pushrules/global/content/${encodeURIComponent('日本語')}`,
      jsonInit('PUT', { actions: ['notify'], pattern: '緊急' })
    );
    expect(ok.status).toBe(200);
    expect(db.rules[0].rule_id).toBe('日本語');
  });
});

describe('pushrules enabled/actions — default condition snapshot leftovers', () => {
  it('disabling invite_for_me stores personalized state_key condition', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.invite_for_me/enabled',
      jsonInit('PUT', { enabled: false })
    );
    const conditions = JSON.parse(db.rules[0].conditions!);
    expect(conditions.find((c: { key?: string }) => c.key === 'state_key').pattern).toBe(USER);
  });

  it('actions on contains_user_name stores null conditions (default has pattern not conditions)', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/content/.m.rule.contains_user_name/actions',
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(db.rules[0].conditions).toBeNull();
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
  });

  it('actions on is_user_mention preserves event_property_contains condition with userId', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.is_user_mention/actions',
      jsonInit('PUT', { actions: ['notify'] })
    );
    const conditions = JSON.parse(db.rules[0].conditions!);
    expect(conditions[0]).toMatchObject({
      kind: 'event_property_contains',
      value: USER,
    });
  });

  it('enabled true on already-enabled custom is idempotent', async () => {
    const db = createPushDb({ rules: [seedRule({ rule_id: 'on', enabled: 1 })] });
    await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/on/enabled',
      jsonInit('PUT', { enabled: true })
    );
    expect(db.rules[0].enabled).toBe(1);
  });

  it('URL-decodes rule id on enabled and actions paths', async () => {
    const id = 'rule space';
    const db = createPushDb({ rules: [seedRule({ rule_id: id })] });
    await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}/enabled`,
      jsonInit('PUT', { enabled: false })
    );
    expect(db.updates[0].args[3]).toBe(id);
    await request(
      db,
      `/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(id)}/actions`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(db.rules[0].rule_id).toBe(id);
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
  });
});

describe('notifications — pagination chain leftovers', () => {
  it('pages with next_token as from for subsequent request', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, created_at: 10, event_id: '$a' }),
        seedNotification({ id: 2, created_at: 20, event_id: '$b' }),
        seedNotification({ id: 3, created_at: 30, event_id: '$c' }),
        seedNotification({ id: 4, created_at: 40, event_id: '$d' }),
      ],
    });
    const page1 = await request(db, '/_matrix/client/v3/notifications?limit=2', authGet());
    expect(page1.body.notifications.map((n: { event: { event_id: string } }) => n.event.event_id)).toEqual(
      ['$d', '$c']
    );
    // last in page is id 3
    expect(page1.body.next_token).toBe('3');

    // from=3 means id > 3 → only id 4, but order DESC → $d only (already seen)
    // Spec-wise clients use opaque tokens; this server interprets as id cursor
    const page2 = await request(
      db,
      `/_matrix/client/v3/notifications?limit=2&from=${page1.body.next_token}`,
      authGet()
    );
    expect(page2.body.notifications.map((n: { event: { event_id: string } }) => n.event.event_id)).toEqual(
      ['$d']
    );
  });

  it('only=highlight with empty highlight set returns []', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, notification_type: 'notify' }),
        seedNotification({ id: 2, notification_type: 'notify', event_id: '$2' }),
      ],
    });
    const res = await request(
      db,
      '/_matrix/client/v3/notifications?only=highlight',
      authGet()
    );
    expect(res.body.notifications).toEqual([]);
    expect(res.body.next_token).toBeUndefined();
  });

  it('default limit 20 when limit omitted', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      seedNotification({ id: i + 1, created_at: i, event_id: `$e${i}` })
    );
    const db = createPushDb({ notifications: many });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.notifications).toHaveLength(20);
  });

  it('ts and origin_server_ts both equal created_at', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 9, created_at: 1_234_567_890 })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(res.body.notifications[0].ts).toBe(1_234_567_890);
    expect(res.body.notifications[0].event.origin_server_ts).toBe(1_234_567_890);
  });

  it('actions empty string parses to [] via catch', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 1, actions: '' })],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    // JSON.parse('') throws → []
    expect(res.body.notifications[0].actions).toEqual([]);
  });

  it('cross-room notifications all returned for user', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1, room_id: '!a:example.com', event_id: '$1' }),
        seedNotification({ id: 2, room_id: '!b:example.com', event_id: '$2' }),
        seedNotification({ id: 3, room_id: '!c:example.com', event_id: '$3' }),
      ],
    });
    const res = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(new Set(res.body.notifications.map((n: { room_id: string }) => n.room_id)).size).toBe(
      3
    );
  });
});

describe('push TOKENMAXX errcode + auth surface leftovers', () => {
  it('all mutating pushers/set success responses are empty objects', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = createPushDb();
    const create = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', VALID_PUSHER_BODY)
    );
    expect(create.body).toEqual({});
    const del = await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        pushkey: VALID_PUSHER_BODY.pushkey,
        kind: null,
        app_id: VALID_PUSHER_BODY.app_id,
      })
    );
    expect(del.body).toEqual({});
    vi.restoreAllMocks();
  });

  it('PUT/DELETE/enabled/actions success bodies are empty objects', async () => {
    const db = createPushDb();
    const base = '/_matrix/client/v3/pushrules/global/override/empty.body';
    expect((await request(db, base, jsonInit('PUT', { actions: ['notify'] }))).body).toEqual({});
    expect(
      (await request(db, `${base}/enabled`, jsonInit('PUT', { enabled: false }))).body
    ).toEqual({});
    expect(
      (await request(db, `${base}/actions`, jsonInit('PUT', { actions: [] }))).body
    ).toEqual({});
    expect(
      (
        await request(db, base, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        })
      ).body
    ).toEqual({});
  });

  it('GET pushrules always wraps under global key; /global unwraps', async () => {
    const db = createPushDb();
    const wrapped = await request(db, '/_matrix/client/v3/pushrules', authGet());
    expect(Object.keys(wrapped.body)).toEqual(['global']);
    expect(Object.keys(wrapped.body.global).sort()).toEqual(
      ['content', 'override', 'room', 'sender', 'underride'].sort()
    );
    const bare = await request(db, '/_matrix/client/v3/pushrules/global', authGet());
    expect(bare.body.global).toBeUndefined();
    expect(Object.keys(bare.body).sort()).toEqual(
      ['content', 'override', 'room', 'sender', 'underride'].sort()
    );
  });

  it('multi-app_id append then selective delete by app_id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = createPushDb();
    const pk = 'multi';
    for (const app_id of ['app.one', 'app.two', 'app.three']) {
      await request(
        db,
        '/_matrix/client/v3/pushers/set',
        jsonInit('POST', { ...VALID_PUSHER_BODY, pushkey: pk, app_id, append: true })
      );
    }
    expect(db.pushers).toHaveLength(3);
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: pk, kind: null, app_id: 'app.two' })
    );
    expect(db.pushers.map((p) => p.app_id).sort()).toEqual(['app.one', 'app.three']);
    vi.restoreAllMocks();
  });

  it('override default .m.rule.contains_display_name has contains_display_name condition', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.contains_display_name',
      authGet()
    );
    expect(res.body.conditions).toEqual([{ kind: 'contains_display_name' }]);
  });

  it('is_room_mention conditions include sender_notification_permission', async () => {
    const db = createPushDb();
    const res = await request(
      db,
      '/_matrix/client/v3/pushrules/global/override/.m.rule.is_room_mention',
      authGet()
    );
    expect(res.body.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'sender_notification_permission', key: 'room' }),
        expect.objectContaining({ kind: 'event_property_is', value: true }),
      ])
    );
  });
});
