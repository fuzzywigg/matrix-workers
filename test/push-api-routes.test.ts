/**
 * TOKENMAXX HEAVY deepen after #100/#101/#102/#103 — different slice: push API routes.
 * Avoids devices/aliases/relations/tags/profile (#100), login/register (#101),
 * admin (#102), account (#103), keys (#99), key-backups, oauth, search.
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
