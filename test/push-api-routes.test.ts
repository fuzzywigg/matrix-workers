/**
 * TOKENMAXX HEAVY deepen — different slice: push HTTP API routes.
 * Avoids presence/report/receipts/typing/to-device/account-data (#105),
 * account (#103), login (#101), admin (#102), devices/profile (#100).
 * Avoids matchesRule / matchesCondition / evaluatePushRules helpers
 * (covered in push-rules.test.ts). Tests-only — no product inventing.
 * Exercises pushers, pushrules CRUD, enabled/actions, notifications.
 */
import { describe, expect, it, vi } from 'vitest';
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
const ROOM = '!r:example.com';
const EVENT = '$e1:example.com';
const EVENT2 = '$e2:example.com';

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
  event_type: string;
  sender: string;
  content: string;
};

type SqlCall = { sql: string; args: unknown[] };
type RunMeta = { changes: number; last_row_id: number };

function createPushDb(opts: {
  pushers?: PusherRow[];
  rules?: PushRuleRow[];
  notifications?: NotificationRow[];
} = {}) {
  const pushers = opts.pushers ?? [];
  const rules = opts.rules ?? [];
  const notifications = opts.notifications ?? [];
  let nextNotifId =
    notifications.reduce((max, n) => Math.max(max, n.id), 0) + 1;

  const selects: SqlCall[] = [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];

  const db = {
    pushers,
    rules,
    notifications,
    selects,
    inserts,
    updates,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('FROM push_rules') &&
                sql.includes('SELECT conditions, actions') &&
                sql.includes('rule_id = ?')
              ) {
                const [userId, kind, ruleId] = args as string[];
                const row = rules.find(
                  (r) =>
                    r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                if (!row) return null as T;
                return {
                  conditions: row.conditions,
                  actions: row.actions,
                } as T;
              }

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },

            async all<T>() {
              selects.push({ sql, args });

              if (sql.includes('FROM pushers') && sql.includes('enabled = 1')) {
                const [userId] = args as string[];
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
                return { results: results as T[] };
              }

              if (
                sql.includes('FROM push_rules') &&
                sql.includes('WHERE user_id = ?') &&
                sql.includes('ORDER BY priority ASC')
              ) {
                const [userId] = args as string[];
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
                return { results: results as T[] };
              }

              if (sql.includes('FROM notification_queue')) {
                const userId = args[0] as string;
                let rows = notifications.filter((n) => n.user_id === userId);

                let argIdx = 1;
                if (sql.includes('nq.id > ?')) {
                  const since = args[argIdx++] as number;
                  rows = rows.filter((n) => n.id > since);
                }
                if (sql.includes("nq.notification_type = 'highlight'")) {
                  rows = rows.filter((n) => n.notification_type === 'highlight');
                }

                const limit = args[args.length - 1] as number;
                rows = [...rows]
                  .sort((a, b) => b.created_at - a.created_at)
                  .slice(0, limit);

                const results = rows.map((n) => ({
                  id: n.id,
                  room_id: n.room_id,
                  event_id: n.event_id,
                  notification_type: n.notification_type,
                  actions: n.actions,
                  read: n.read,
                  created_at: n.created_at,
                  event_type: n.event_type,
                  sender: n.sender,
                  content: n.content,
                }));
                return { results: results as T[] };
              }

              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 160)}`);
            },

            async run(): Promise<{ success: true; meta: RunMeta }> {
              if (sql.includes('DELETE FROM pushers')) {
                deletes.push({ sql, args });
                const userId = args[0] as string;
                const pushkey = args[1] as string;
                let removed = 0;
                for (let i = pushers.length - 1; i >= 0; i--) {
                  const p = pushers[i];
                  if (p.user_id !== userId || p.pushkey !== pushkey) continue;
                  if (sql.includes('app_id = ?')) {
                    const appId = args[2] as string;
                    if (p.app_id !== appId) continue;
                  }
                  pushers.splice(i, 1);
                  removed++;
                }
                return {
                  success: true,
                  meta: { changes: removed, last_row_id: 0 },
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
                const idx = pushers.findIndex(
                  (p) =>
                    p.user_id === userId &&
                    p.pushkey === pushkey &&
                    p.app_id === appId
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
                if (idx >= 0) pushers[idx] = row;
                else pushers.push(row);
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: pushers.length },
                };
              }

              if (
                sql.includes('INSERT INTO push_rules') &&
                sql.includes('ON CONFLICT')
              ) {
                inserts.push({ sql, args });
                // enabled path for default override: (?, ?, ?, ?, ?, ?, 0)
                // create path: (?, ?, ?, ?, ?, 1, ?)
                // actions path: (?, ?, ?, ?, ?, 1, 0)
                if (sql.includes('enabled = excluded.enabled')) {
                  const [userId, kind, ruleId, conditions, actions, enabled] =
                    args as [string, string, string, string | null, string, number];
                  const idx = rules.findIndex(
                    (r) =>
                      r.user_id === userId &&
                      r.kind === kind &&
                      r.rule_id === ruleId
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
                    rules[idx] = { ...rules[idx], enabled };
                  } else {
                    rules.push(row);
                  }
                  return {
                    success: true,
                    meta: { changes: 1, last_row_id: rules.length },
                  };
                }

                if (sql.includes('actions = excluded.actions') && !sql.includes('conditions = excluded.conditions')) {
                  const [userId, kind, ruleId, conditions, actions] = args as [
                    string,
                    string,
                    string,
                    string | null,
                    string,
                  ];
                  const idx = rules.findIndex(
                    (r) =>
                      r.user_id === userId &&
                      r.kind === kind &&
                      r.rule_id === ruleId
                  );
                  const row: PushRuleRow = {
                    user_id: userId,
                    kind,
                    rule_id: ruleId,
                    conditions,
                    actions,
                    enabled: 1,
                    priority: 0,
                  };
                  if (idx >= 0) {
                    rules[idx] = { ...rules[idx], actions, conditions };
                  } else {
                    rules.push(row);
                  }
                  return {
                    success: true,
                    meta: { changes: 1, last_row_id: rules.length },
                  };
                }

                // create/update with conditions + priority
                const [userId, kind, ruleId, conditions, actions, priority] =
                  args as [string, string, string, string | null, string, number];
                const idx = rules.findIndex(
                  (r) =>
                    r.user_id === userId &&
                    r.kind === kind &&
                    r.rule_id === ruleId
                );
                const row: PushRuleRow = {
                  user_id: userId,
                  kind,
                  rule_id: ruleId,
                  conditions,
                  actions,
                  enabled: 1,
                  priority,
                };
                if (idx >= 0) {
                  rules[idx] = {
                    ...rules[idx],
                    conditions,
                    actions,
                    priority,
                  };
                } else {
                  rules.push(row);
                }
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: rules.length },
                };
              }

              if (sql.includes('UPDATE push_rules SET enabled')) {
                updates.push({ sql, args });
                const [enabled, userId, kind, ruleId] = args as [
                  number,
                  string,
                  string,
                  string,
                ];
                const row = rules.find(
                  (r) =>
                    r.user_id === userId &&
                    r.kind === kind &&
                    r.rule_id === ruleId
                );
                if (row) row.enabled = enabled;
                return {
                  success: true,
                  meta: { changes: row ? 1 : 0, last_row_id: 0 },
                };
              }

              if (sql.includes('DELETE FROM push_rules')) {
                deletes.push({ sql, args });
                const [userId, kind, ruleId] = args as string[];
                const idx = rules.findIndex(
                  (r) =>
                    r.user_id === userId &&
                    r.kind === kind &&
                    r.rule_id === ruleId
                );
                if (idx < 0) {
                  return {
                    success: true,
                    meta: { changes: 0, last_row_id: 0 },
                  };
                }
                rules.splice(idx, 1);
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: 0 },
                };
              }

              if (sql.includes('INSERT INTO notification_queue')) {
                inserts.push({ sql, args });
                const [userId, roomId, eventId, notificationType, actions] =
                  args as [string, string, string, string, string];
                notifications.push({
                  id: nextNotifId++,
                  user_id: userId,
                  room_id: roomId,
                  event_id: eventId,
                  notification_type: notificationType,
                  actions,
                  read: 0,
                  created_at: Date.now(),
                  event_type: 'm.room.message',
                  sender: BOB,
                  content: '{}',
                });
                return {
                  success: true,
                  meta: { changes: 1, last_row_id: nextNotifId - 1 },
                };
              }

              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 160)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type PushDb = ReturnType<typeof createPushDb>;

function createEnv(opts: { db?: PushDb } = {}) {
  const db = opts.db ?? createPushDb();
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    _db: db,
  };
  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await pushApp.request(`http://localhost${path}`, init, env);
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

function getInit(): RequestInit {
  return {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  };
}

function deleteInit(): RequestInit {
  return {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  };
}

function errcode(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'errcode' in body) {
    return String((body as { errcode: string }).errcode);
  }
  return undefined;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body as Record<string, unknown>;
}

const VALID_PUSHER = {
  pushkey: 'fcm-token-abc',
  kind: 'http',
  app_id: 'im.vector.app',
  app_display_name: 'Element',
  device_display_name: 'Pixel',
  lang: 'en',
  data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only' },
};

function rulePath(kind: string, ruleId: string, scope = 'global') {
  return `/_matrix/client/v3/pushrules/${scope}/${kind}/${encodeURIComponent(ruleId)}`;
}

// ---------------------------------------------------------------------------
// GET /pushers
// ---------------------------------------------------------------------------

describe('push GET /_matrix/client/v3/pushers', () => {
  it('returns empty pushers list', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers',
      getInit()
    );
    expect(status).toBe(200);
    expect(asRecord(body).pushers).toEqual([]);
  });

  it('returns enabled pushers with parsed data and omits null profile_tag', async () => {
    const env = createEnv({
      db: createPushDb({
        pushers: [
          {
            user_id: USER,
            pushkey: 'k1',
            kind: 'http',
            app_id: 'app.a',
            app_display_name: 'App A',
            device_display_name: 'Phone',
            profile_tag: null,
            lang: 'en',
            data: JSON.stringify({ url: 'https://a.example/push' }),
            enabled: 1,
          },
          {
            user_id: USER,
            pushkey: 'k2',
            kind: 'http',
            app_id: 'app.b',
            app_display_name: 'App B',
            device_display_name: 'Tablet',
            profile_tag: 'tag-b',
            lang: 'de',
            data: JSON.stringify({ format: 'event_id_only' }),
            enabled: 1,
          },
          {
            user_id: USER,
            pushkey: 'disabled',
            kind: 'http',
            app_id: 'app.c',
            app_display_name: 'Off',
            device_display_name: 'X',
            profile_tag: null,
            lang: 'en',
            data: '{}',
            enabled: 0,
          },
          {
            user_id: BOB,
            pushkey: 'other',
            kind: 'http',
            app_id: 'app.d',
            app_display_name: 'Other',
            device_display_name: 'Y',
            profile_tag: null,
            lang: 'en',
            data: '{}',
            enabled: 1,
          },
        ],
      }),
    });

    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers',
      getInit()
    );
    expect(status).toBe(200);
    const pushers = asRecord(body).pushers as Array<Record<string, unknown>>;
    expect(pushers).toHaveLength(2);
    expect(pushers[0]).toMatchObject({
      pushkey: 'k1',
      app_id: 'app.a',
      data: { url: 'https://a.example/push' },
    });
    expect(pushers[0].profile_tag).toBeUndefined();
    expect(pushers[1]).toMatchObject({
      pushkey: 'k2',
      profile_tag: 'tag-b',
      lang: 'de',
      data: { format: 'event_id_only' },
    });
  });

  it('binds authenticated user_id in SELECT', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    await request(env, '/_matrix/client/v3/pushers', getInit());
    const sel = db.selects.find((s) => s.sql.includes('FROM pushers'));
    expect(sel?.args).toEqual([USER]);
  });
});

// ---------------------------------------------------------------------------
// POST /pushers/set
// ---------------------------------------------------------------------------

describe('push POST /_matrix/client/v3/pushers/set', () => {
  it('rejects bad JSON', async () => {
    const env = createEnv();
    const { status, body } = await request(env, '/_matrix/client/v3/pushers/set', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{not-json',
    });
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_BAD_JSON');
  });

  it('requires pushkey', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { kind: 'http', app_id: 'x' })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_MISSING_PARAM');
    expect(String(asRecord(body).error)).toContain('pushkey');
  });

  it('deletes pusher when kind is null', async () => {
    const db = createPushDb({
      pushers: [
        {
          user_id: USER,
          pushkey: 'k1',
          kind: 'http',
          app_id: 'im.vector.app',
          app_display_name: 'Element',
          device_display_name: 'Phone',
          profile_tag: null,
          lang: 'en',
          data: '{}',
          enabled: 1,
        },
        {
          user_id: USER,
          pushkey: 'k1',
          kind: 'http',
          app_id: 'other.app',
          app_display_name: 'Other',
          device_display_name: 'Phone',
          profile_tag: null,
          lang: 'en',
          data: '{}',
          enabled: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        pushkey: 'k1',
        kind: null,
        app_id: 'im.vector.app',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.pushers).toHaveLength(1);
    expect(db.pushers[0].app_id).toBe('other.app');
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM pushers'))).toBe(
      true
    );
  });

  it('deletes with empty app_id when app_id omitted on kind null', async () => {
    const db = createPushDb({
      pushers: [
        {
          user_id: USER,
          pushkey: 'k1',
          kind: 'http',
          app_id: '',
          app_display_name: 'X',
          device_display_name: 'Y',
          profile_tag: null,
          lang: 'en',
          data: '{}',
          enabled: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'k1', kind: null })
    );
    expect(status).toBe(200);
    expect(db.pushers).toHaveLength(0);
    const del = db.deletes.find((d) => d.sql.includes('app_id = ?'));
    expect(del?.args).toEqual([USER, 'k1', '']);
  });

  it('requires fields when creating', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'k', kind: 'http' })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_MISSING_PARAM');
    expect(String(asRecord(body).error)).toContain('app_id');
  });

  it('creates pusher and replaces same pushkey when append omitted', async () => {
    const db = createPushDb({
      pushers: [
        {
          user_id: USER,
          pushkey: VALID_PUSHER.pushkey,
          kind: 'http',
          app_id: 'old.app',
          app_display_name: 'Old',
          device_display_name: 'OldDev',
          profile_tag: null,
          lang: 'en',
          data: '{}',
          enabled: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { ...VALID_PUSHER, profile_tag: 'pt' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM pushers'))).toBe(
      true
    );
    expect(db.pushers).toHaveLength(1);
    expect(db.pushers[0]).toMatchObject({
      pushkey: VALID_PUSHER.pushkey,
      app_id: VALID_PUSHER.app_id,
      profile_tag: 'pt',
      kind: 'http',
    });
    expect(JSON.parse(db.pushers[0].data)).toEqual(VALID_PUSHER.data);
  });

  it('keeps other pushkey apps when append=true', async () => {
    const db = createPushDb({
      pushers: [
        {
          user_id: USER,
          pushkey: 'shared-key',
          kind: 'http',
          app_id: 'app.one',
          app_display_name: 'One',
          device_display_name: 'D1',
          profile_tag: null,
          lang: 'en',
          data: '{}',
          enabled: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER,
        pushkey: 'shared-key',
        app_id: 'app.two',
        append: true,
      })
    );
    expect(status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('DELETE FROM pushers'))).toHaveLength(
      0
    );
    expect(db.pushers).toHaveLength(2);
    expect(db.pushers.map((p) => p.app_id).sort()).toEqual(['app.one', 'app.two']);
  });

  it('upserts on conflict for same user/pushkey/app_id', async () => {
    const db = createPushDb({
      pushers: [
        {
          user_id: USER,
          pushkey: VALID_PUSHER.pushkey,
          kind: 'http',
          app_id: VALID_PUSHER.app_id,
          app_display_name: 'OldName',
          device_display_name: 'OldDev',
          profile_tag: null,
          lang: 'en',
          data: '{}',
          enabled: 1,
        },
      ],
    });
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', {
        ...VALID_PUSHER,
        append: true,
        app_display_name: 'NewName',
        device_display_name: 'NewDev',
      })
    );
    expect(db.pushers).toHaveLength(1);
    expect(db.pushers[0].app_display_name).toBe('NewName');
    expect(db.pushers[0].device_display_name).toBe('NewDev');
  });

  it('stores null profile_tag when omitted', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', VALID_PUSHER)
    );
    expect(db.pushers[0].profile_tag).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET pushrules (/, trailing slash, /global)
// ---------------------------------------------------------------------------

describe('push GET /_matrix/client/v3/pushrules', () => {
  it('returns default global rules with user-specific customizations', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushrules',
      getInit()
    );
    expect(status).toBe(200);
    const global = asRecord(body).global as Record<string, unknown[]>;
    expect(Array.isArray(global.override)).toBe(true);
    expect(Array.isArray(global.content)).toBe(true);
    expect(Array.isArray(global.room)).toBe(true);
    expect(Array.isArray(global.sender)).toBe(true);
    expect(Array.isArray(global.underride)).toBe(true);

    const invite = (global.override as Array<Record<string, unknown>>).find(
      (r) => r.rule_id === '.m.rule.invite_for_me'
    );
    expect(invite).toBeTruthy();
    const inviteConds = invite!.conditions as Array<Record<string, unknown>>;
    expect(inviteConds.find((c) => c.key === 'state_key')?.pattern).toBe(USER);

    const mention = (global.override as Array<Record<string, unknown>>).find(
      (r) => r.rule_id === '.m.rule.is_user_mention'
    );
    const mentionConds = mention!.conditions as Array<Record<string, unknown>>;
    expect(
      mentionConds.find((c) => String(c.key).includes('user_ids'))?.value
    ).toBe(USER);

    const content = (global.content as Array<Record<string, unknown>>).find(
      (r) => r.rule_id === '.m.rule.contains_user_name'
    );
    expect(content?.pattern).toBe('alice');

    const master = (global.override as Array<Record<string, unknown>>).find(
      (r) => r.rule_id === '.m.rule.master'
    );
    expect(master?.enabled).toBe(false);
    expect(master?.default).toBe(true);
  });

  it('GET /pushrules/ trailing slash matches same shape', async () => {
    const env = createEnv();
    const a = await request(env, '/_matrix/client/v3/pushrules', getInit());
    const b = await request(env, '/_matrix/client/v3/pushrules/', getInit());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  it('GET /pushrules/global returns only global object', async () => {
    const env = createEnv();
    const full = await request(env, '/_matrix/client/v3/pushrules', getInit());
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushrules/global',
      getInit()
    );
    expect(status).toBe(200);
    expect(body).toEqual(asRecord(full.body).global);
    expect(asRecord(body).override).toBeTruthy();
    expect(asRecord(body).global).toBeUndefined();
  });

  it('merges custom rules: override default by rule_id and unshift new', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'override',
          rule_id: '.m.rule.master',
          conditions: null,
          actions: JSON.stringify(['notify']),
          enabled: 1,
          priority: 1,
        },
        {
          user_id: USER,
          kind: 'content',
          rule_id: 'custom.keyword',
          conditions: null,
          actions: JSON.stringify(['notify']),
          enabled: 1,
          priority: 0,
        },
        {
          user_id: USER,
          kind: 'room',
          rule_id: ROOM,
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'room_id', pattern: ROOM },
          ]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 0,
          priority: 2,
        },
        {
          user_id: BOB,
          kind: 'content',
          rule_id: 'bob.only',
          conditions: null,
          actions: JSON.stringify(['notify']),
          enabled: 1,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushrules',
      getInit()
    );
    expect(status).toBe(200);
    const global = asRecord(body).global as Record<string, Array<Record<string, unknown>>>;

    const master = global.override.find((r) => r.rule_id === '.m.rule.master');
    expect(master?.enabled).toBe(true);
    expect(master?.actions).toEqual(['notify']);
    expect(master?.default).toBe(true);

    expect(global.content[0].rule_id).toBe('custom.keyword');
    expect(global.content.some((r) => r.rule_id === '.m.rule.contains_user_name')).toBe(
      true
    );

    expect(global.room).toHaveLength(1);
    expect(global.room[0]).toMatchObject({
      rule_id: ROOM,
      enabled: false,
      actions: ['dont_notify'],
    });

    expect(global.content.some((r) => r.rule_id === 'bob.only')).toBe(false);
  });

  it('tolerates invalid JSON in custom conditions/actions', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'sender',
          rule_id: '@evil:example.com',
          conditions: '{bad',
          actions: 'not-json',
          enabled: 1,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushrules',
      getInit()
    );
    expect(status).toBe(200);
    const global = asRecord(body).global as Record<string, Array<Record<string, unknown>>>;
    expect(global.sender[0]).toMatchObject({
      rule_id: '@evil:example.com',
      actions: [],
    });
    expect(global.sender[0].conditions).toBeUndefined();
  });

  it('ignores unknown kind rows without throwing', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'not_a_real_kind',
          rule_id: 'x',
          conditions: null,
          actions: '[]',
          enabled: 1,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(env, '/_matrix/client/v3/pushrules', getInit());
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET specific rule
// ---------------------------------------------------------------------------

describe('push GET /_matrix/client/v3/pushrules/:scope/:kind/:ruleId', () => {
  it('rejects non-global scope', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('override', '.m.rule.master', 'device'),
      getInit()
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_INVALID_PARAM');
    expect(String(asRecord(body).error)).toMatch(/global/i);
  });

  it('rejects unknown kind', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('bogus', 'r1'),
      getInit()
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_INVALID_PARAM');
    expect(String(asRecord(body).error)).toContain('bogus');
  });

  it('returns 404 when rule missing', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('content', 'no.such.rule'),
      getInit()
    );
    expect(status).toBe(404);
    expect(errcode(body)).toBe('M_NOT_FOUND');
  });

  it('returns a default override rule', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('override', '.m.rule.suppress_notices'),
      getInit()
    );
    expect(status).toBe(200);
    expect(asRecord(body)).toMatchObject({
      rule_id: '.m.rule.suppress_notices',
      default: true,
      enabled: true,
      actions: ['dont_notify'],
    });
  });

  it('returns custom rule and decodes ruleId', async () => {
    const ruleId = 'my rule/with spaces';
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'content',
          rule_id: ruleId,
          conditions: null,
          actions: JSON.stringify(['notify']),
          enabled: 1,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      rulePath('content', ruleId),
      getInit()
    );
    expect(status).toBe(200);
    expect(asRecord(body).rule_id).toBe(ruleId);
    expect(asRecord(body).actions).toEqual(['notify']);
  });

  it('returns underride call rule', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('underride', '.m.rule.call'),
      getInit()
    );
    expect(status).toBe(200);
    expect(asRecord(body).rule_id).toBe('.m.rule.call');
  });
});

// ---------------------------------------------------------------------------
// PUT create/update rule
// ---------------------------------------------------------------------------

describe('push PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId', () => {
  it('rejects non-global scope', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('content', 'x', 'device'),
      jsonInit('PUT', { actions: ['notify'], pattern: 'hi' })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_INVALID_PARAM');
  });

  it('cannot overwrite default .m.rule.* ids', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('override', '.m.rule.master'),
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_CANNOT_OVERWRITE_DEFAULT');
  });

  it('rejects bad JSON', async () => {
    const env = createEnv();
    const { status, body } = await request(env, rulePath('content', 'r'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'null-ish{',
    });
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_BAD_JSON');
  });

  it('requires actions', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('override', 'custom.a'),
      jsonInit('PUT', { conditions: [] })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_MISSING_PARAM');
    expect(String(asRecord(body).error)).toContain('actions');
  });

  it('requires pattern for content kind', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('content', 'kw'),
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_MISSING_PARAM');
    expect(String(asRecord(body).error)).toContain('pattern');
  });

  it('creates content rule with pattern', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      rulePath('content', 'kw.urgent'),
      jsonInit('PUT', {
        actions: ['notify', { set_tweak: 'highlight', value: true }],
        pattern: 'URGENT*',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0]).toMatchObject({
      user_id: USER,
      kind: 'content',
      rule_id: 'kw.urgent',
      conditions: null,
      priority: 0,
      enabled: 1,
    });
    expect(JSON.parse(db.rules[0].actions)).toEqual([
      'notify',
      { set_tweak: 'highlight', value: true },
    ]);

    const get = await request(env, rulePath('content', 'kw.urgent'), getInit());
    expect(get.status).toBe(200);
    expect(asRecord(get.body).actions).toEqual([
      'notify',
      { set_tweak: 'highlight', value: true },
    ]);
  });

  it('creates override rule with conditions and before query sets priority', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    const before = Date.now();
    const { status } = await request(
      env,
      `${rulePath('override', 'custom.mute')}?before=.m.rule.master`,
      jsonInit('PUT', {
        actions: ['dont_notify'],
        conditions: [
          { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
        ],
      })
    );
    expect(status).toBe(200);
    expect(db.rules[0].priority).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(db.rules[0].conditions!)).toEqual([
      { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
    ]);
  });

  it('after query also bumps priority; update replaces existing', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'room',
          rule_id: ROOM,
          conditions: null,
          actions: JSON.stringify(['notify']),
          enabled: 1,
          priority: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(
      env,
      `${rulePath('room', ROOM)}?after=x`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(status).toBe(200);
    expect(db.rules).toHaveLength(1);
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
    expect(db.rules[0].priority).toBeGreaterThan(1);
  });

  it('sender kind without pattern succeeds', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    const { status } = await request(
      env,
      rulePath('sender', BOB),
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(status).toBe(200);
    expect(db.rules[0].kind).toBe('sender');
    expect(db.rules[0].rule_id).toBe(BOB);
  });
});

// ---------------------------------------------------------------------------
// DELETE rule
// ---------------------------------------------------------------------------

describe('push DELETE /_matrix/client/v3/pushrules/:scope/:kind/:ruleId', () => {
  it('rejects non-global scope', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('content', 'x', 'device'),
      deleteInit()
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_INVALID_PARAM');
  });

  it('cannot delete default rules', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('underride', '.m.rule.message'),
      deleteInit()
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_CANNOT_DELETE_DEFAULT');
  });

  it('returns 404 when custom rule missing', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      rulePath('content', 'gone'),
      deleteInit()
    );
    expect(status).toBe(404);
    expect(errcode(body)).toBe('M_NOT_FOUND');
  });

  it('deletes custom rule', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'content',
          rule_id: 'kw',
          conditions: null,
          actions: '["notify"]',
          enabled: 1,
          priority: 0,
        },
        {
          user_id: USER,
          kind: 'content',
          rule_id: 'keep',
          conditions: null,
          actions: '["notify"]',
          enabled: 1,
          priority: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      rulePath('content', 'kw'),
      deleteInit()
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rules.map((r) => r.rule_id)).toEqual(['keep']);
  });
});

// ---------------------------------------------------------------------------
// PUT enabled
// ---------------------------------------------------------------------------

describe('push PUT .../enabled', () => {
  it('rejects bad JSON', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.master')}/enabled`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: '{',
      }
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_BAD_JSON');
  });

  it('requires boolean enabled', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.master')}/enabled`,
      jsonInit('PUT', { enabled: 'yes' })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_MISSING_PARAM');
  });

  it('upserts override for default rule enable', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.master')}/enabled`,
      jsonInit('PUT', { enabled: true })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0]).toMatchObject({
      rule_id: '.m.rule.master',
      kind: 'override',
      enabled: 1,
    });
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);

    const listed = await request(env, '/_matrix/client/v3/pushrules', getInit());
    const global = asRecord(listed.body).global as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const master = global.override.find((r) => r.rule_id === '.m.rule.master');
    expect(master?.enabled).toBe(true);
  });

  it('disables default rule via override entry', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    await request(
      env,
      `${rulePath('content', '.m.rule.contains_user_name')}/enabled`,
      jsonInit('PUT', { enabled: false })
    );
    expect(db.rules[0].enabled).toBe(0);
    expect(db.rules[0].kind).toBe('content');
  });

  it('404 for unknown default rule id', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.not_a_real_default')}/enabled`,
      jsonInit('PUT', { enabled: false })
    );
    expect(status).toBe(404);
    expect(errcode(body)).toBe('M_NOT_FOUND');
  });

  it('updates custom rule enabled flag', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'content',
          rule_id: 'kw',
          conditions: null,
          actions: '["notify"]',
          enabled: 1,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(
      env,
      `${rulePath('content', 'kw')}/enabled`,
      jsonInit('PUT', { enabled: false })
    );
    expect(status).toBe(200);
    expect(db.rules[0].enabled).toBe(0);
    expect(db.updates.some((u) => u.sql.includes('UPDATE push_rules'))).toBe(
      true
    );
  });

  it('ON CONFLICT updates enabled on existing default override', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'override',
          rule_id: '.m.rule.master',
          conditions: null,
          actions: '["dont_notify"]',
          enabled: 0,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    await request(
      env,
      `${rulePath('override', '.m.rule.master')}/enabled`,
      jsonInit('PUT', { enabled: true })
    );
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0].enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PUT actions
// ---------------------------------------------------------------------------

describe('push PUT .../actions', () => {
  it('rejects bad JSON', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.master')}/actions`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: 'nope',
      }
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_BAD_JSON');
  });

  it('requires actions array', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.master')}/actions`,
      jsonInit('PUT', { actions: 'notify' })
    );
    expect(status).toBe(400);
    expect(errcode(body)).toBe('M_MISSING_PARAM');
  });

  it('updates actions for existing custom rule and preserves conditions', async () => {
    const conds = [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }];
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'override',
          rule_id: 'custom.a',
          conditions: JSON.stringify(conds),
          actions: JSON.stringify(['notify']),
          enabled: 1,
          priority: 3,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(
      env,
      `${rulePath('override', 'custom.a')}/actions`,
      jsonInit('PUT', { actions: ['dont_notify'] })
    );
    expect(status).toBe(200);
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);
    expect(JSON.parse(db.rules[0].conditions!)).toEqual(conds);
  });

  it('creates override from default rule when setting actions', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    const { status } = await request(
      env,
      `${rulePath('underride', '.m.rule.message')}/actions`,
      jsonInit('PUT', {
        actions: ['notify', { set_tweak: 'sound', value: 'default' }],
      })
    );
    expect(status).toBe(200);
    expect(db.rules).toHaveLength(1);
    expect(db.rules[0].rule_id).toBe('.m.rule.message');
    expect(JSON.parse(db.rules[0].actions)).toEqual([
      'notify',
      { set_tweak: 'sound', value: 'default' },
    ]);
    expect(JSON.parse(db.rules[0].conditions!)).toEqual([
      { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
    ]);
  });

  it('404 for unknown default rule', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('override', '.m.rule.nope')}/actions`,
      jsonInit('PUT', { actions: [] })
    );
    expect(status).toBe(404);
    expect(errcode(body)).toBe('M_NOT_FOUND');
  });

  it('404 for missing custom non-default rule', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      `${rulePath('content', 'missing.kw')}/actions`,
      jsonInit('PUT', { actions: ['notify'] })
    );
    expect(status).toBe(404);
    expect(errcode(body)).toBe('M_NOT_FOUND');
  });

  it('tolerates invalid stored conditions JSON on custom rule', async () => {
    const db = createPushDb({
      rules: [
        {
          user_id: USER,
          kind: 'content',
          rule_id: 'kw',
          conditions: '{bad',
          actions: '["notify"]',
          enabled: 1,
          priority: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const { status } = await request(
      env,
      `${rulePath('content', 'kw')}/actions`,
      jsonInit('PUT', { actions: [] })
    );
    expect(status).toBe(200);
    expect(db.rules[0].conditions).toBeNull();
    expect(JSON.parse(db.rules[0].actions)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET notifications
// ---------------------------------------------------------------------------

describe('push GET /_matrix/client/v3/notifications', () => {
  it('returns empty list without next_token', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/notifications',
      getInit()
    );
    expect(status).toBe(200);
    expect(asRecord(body).notifications).toEqual([]);
    expect(asRecord(body).next_token).toBeUndefined();
  });

  it('maps notification rows with parsed event content and actions', async () => {
    const db = createPushDb({
      notifications: [
        {
          id: 10,
          user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          notification_type: 'notify',
          actions: JSON.stringify(['notify']),
          read: 0,
          created_at: 1_700_000_000_000,
          event_type: 'm.room.message',
          sender: BOB,
          content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
        },
        {
          id: 11,
          user_id: USER,
          room_id: ROOM,
          event_id: EVENT2,
          notification_type: 'highlight',
          actions: JSON.stringify([
            'notify',
            { set_tweak: 'highlight', value: true },
          ]),
          read: 1,
          created_at: 1_700_000_000_100,
          event_type: 'm.room.message',
          sender: BOB,
          content: JSON.stringify({ body: 'Alice!' }),
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/notifications',
      getInit()
    );
    expect(status).toBe(200);
    const list = asRecord(body).notifications as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    // ordered by created_at DESC
    expect(list[0]).toMatchObject({
      room_id: ROOM,
      read: true,
      ts: 1_700_000_000_100,
      actions: ['notify', { set_tweak: 'highlight', value: true }],
    });
    expect(asRecord(list[0].event)).toMatchObject({
      event_id: EVENT2,
      type: 'm.room.message',
      sender: BOB,
      content: { body: 'Alice!' },
      room_id: ROOM,
      origin_server_ts: 1_700_000_000_100,
    });
    expect(list[1]).toMatchObject({
      read: false,
      actions: ['notify'],
    });
    expect(asRecord(body).next_token).toBe('10');
  });

  it('filters only=highlight and from pagination', async () => {
    const db = createPushDb({
      notifications: [
        {
          id: 1,
          user_id: USER,
          room_id: ROOM,
          event_id: '$a',
          notification_type: 'notify',
          actions: '[]',
          read: 0,
          created_at: 100,
          event_type: 'm.room.message',
          sender: BOB,
          content: '{}',
        },
        {
          id: 2,
          user_id: USER,
          room_id: ROOM,
          event_id: '$b',
          notification_type: 'highlight',
          actions: '[]',
          read: 0,
          created_at: 200,
          event_type: 'm.room.message',
          sender: BOB,
          content: '{}',
        },
        {
          id: 3,
          user_id: USER,
          room_id: ROOM,
          event_id: '$c',
          notification_type: 'highlight',
          actions: '[]',
          read: 0,
          created_at: 300,
          event_type: 'm.room.message',
          sender: BOB,
          content: '{}',
        },
        {
          id: 4,
          user_id: BOB,
          room_id: ROOM,
          event_id: '$d',
          notification_type: 'highlight',
          actions: '[]',
          read: 0,
          created_at: 400,
          event_type: 'm.room.message',
          sender: USER,
          content: '{}',
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/notifications?only=highlight&from=1&limit=10',
      getInit()
    );
    expect(status).toBe(200);
    const list = asRecord(body).notifications as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(
      list.map((n) => (asRecord(n.event).event_id as string))
    ).toEqual(['$c', '$b']);

    const sel = db.selects.find((s) => s.sql.includes('FROM notification_queue'));
    expect(sel?.sql).toContain('nq.id > ?');
    expect(sel?.sql).toContain("nq.notification_type = 'highlight'");
    expect(sel?.args).toEqual([USER, 1, 10]);
  });

  it('caps limit at 100 and defaults limit to 20', async () => {
    const rows: NotificationRow[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      user_id: USER,
      room_id: ROOM,
      event_id: `$e${i}`,
      notification_type: 'notify',
      actions: '[]',
      read: 0,
      created_at: 1000 + i,
      event_type: 'm.room.message',
      sender: BOB,
      content: '{}',
    }));
    const db = createPushDb({ notifications: rows });
    const env = createEnv({ db });

    const def = await request(env, '/_matrix/client/v3/notifications', getInit());
    expect((asRecord(def.body).notifications as unknown[]).length).toBe(20);

    const capped = await request(
      env,
      '/_matrix/client/v3/notifications?limit=999',
      getInit()
    );
    const sel = db.selects.filter((s) =>
      s.sql.includes('FROM notification_queue')
    );
    expect(sel[sel.length - 1].args[sel[sel.length - 1].args.length - 1]).toBe(
      100
    );
    expect((asRecord(capped.body).notifications as unknown[]).length).toBe(30);
  });

  it('treats invalid from as 0 (no id filter)', async () => {
    const db = createPushDb({
      notifications: [
        {
          id: 5,
          user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          notification_type: 'notify',
          actions: '[]',
          read: 0,
          created_at: 1,
          event_type: 'm.room.message',
          sender: BOB,
          content: '{}',
        },
      ],
    });
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/notifications?from=not-a-number',
      getInit()
    );
    const sel = db.selects.find((s) => s.sql.includes('FROM notification_queue'));
    expect(sel?.sql).not.toContain('nq.id > ?');
    expect(sel?.args).toEqual([USER, 20]);
  });

  it('tolerates invalid content/actions JSON', async () => {
    const db = createPushDb({
      notifications: [
        {
          id: 1,
          user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          notification_type: 'notify',
          actions: '{bad',
          read: 0,
          created_at: 1,
          event_type: 'm.room.message',
          sender: BOB,
          content: '{bad',
        },
      ],
    });
    const env = createEnv({ db });
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/notifications',
      getInit()
    );
    expect(status).toBe(200);
    const n = (asRecord(body).notifications as Array<Record<string, unknown>>)[0];
    expect(asRecord(n.event).content).toEqual({});
    expect(n.actions).toEqual([]);
  });

  it('handles nullish event content via empty object fallback', async () => {
    const db = createPushDb({
      notifications: [
        {
          id: 1,
          user_id: USER,
          room_id: ROOM,
          event_id: EVENT,
          notification_type: 'notify',
          actions: '',
          read: 0,
          created_at: 1,
          event_type: 'm.room.message',
          sender: BOB,
          content: '',
        },
      ],
    });
    const env = createEnv({ db });
    const { body } = await request(
      env,
      '/_matrix/client/v3/notifications',
      getInit()
    );
    const n = (asRecord(body).notifications as Array<Record<string, unknown>>)[0];
    expect(asRecord(n.event).content).toEqual({});
    expect(n.actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-route TOKENMAXX edges
// ---------------------------------------------------------------------------

describe('push TOKENMAXX cross-route edges', () => {
  it('round-trips custom rule create → get → enable → actions → delete', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    const id = 'lifecycle.rule';

    expect(
      (
        await request(
          env,
          rulePath('override', id),
          jsonInit('PUT', {
            actions: ['notify'],
            conditions: [
              { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
            ],
          })
        )
      ).status
    ).toBe(200);

    const got = await request(env, rulePath('override', id), getInit());
    expect(got.status).toBe(200);
    expect(asRecord(got.body).rule_id).toBe(id);

    expect(
      (
        await request(
          env,
          `${rulePath('override', id)}/enabled`,
          jsonInit('PUT', { enabled: false })
        )
      ).status
    ).toBe(200);
    expect(db.rules[0].enabled).toBe(0);

    expect(
      (
        await request(
          env,
          `${rulePath('override', id)}/actions`,
          jsonInit('PUT', { actions: ['dont_notify'] })
        )
      ).status
    ).toBe(200);
    expect(JSON.parse(db.rules[0].actions)).toEqual(['dont_notify']);

    expect(
      (await request(env, rulePath('override', id), deleteInit())).status
    ).toBe(200);
    expect(db.rules).toHaveLength(0);
    expect(
      (await request(env, rulePath('override', id), getInit())).status
    ).toBe(404);
  });

  it('pusher set then list reflects registration', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', VALID_PUSHER)
    );
    const listed = await request(env, '/_matrix/client/v3/pushers', getInit());
    const pushers = asRecord(listed.body).pushers as Array<Record<string, unknown>>;
    expect(pushers).toHaveLength(1);
    expect(pushers[0]).toMatchObject({
      pushkey: VALID_PUSHER.pushkey,
      kind: 'http',
      app_id: VALID_PUSHER.app_id,
      data: VALID_PUSHER.data,
    });
  });

  it('default rule kinds cover master, content localpart, underride message', async () => {
    const env = createEnv();
    for (const [kind, ruleId] of [
      ['override', '.m.rule.reaction'],
      ['override', '.m.rule.tombstone'],
      ['override', '.m.rule.room.server_acl'],
      ['underride', '.m.rule.encrypted'],
      ['underride', '.m.rule.room_one_to_one'],
      ['underride', '.m.rule.encrypted_room_one_to_one'],
    ] as const) {
      const { status, body } = await request(
        env,
        rulePath(kind, ruleId),
        getInit()
      );
      expect(status).toBe(200);
      expect(asRecord(body).rule_id).toBe(ruleId);
      expect(asRecord(body).default).toBe(true);
    }
  });

  it('room and sender default lists start empty until custom rules added', async () => {
    const env = createEnv();
    const { body } = await request(
      env,
      '/_matrix/client/v3/pushrules/global',
      getInit()
    );
    expect(asRecord(body).room).toEqual([]);
    expect(asRecord(body).sender).toEqual([]);
  });

  it('delete kind=null does not require create fields', async () => {
    const env = createEnv();
    const { status, body } = await request(
      env,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'missing', kind: null, app_id: 'x' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('from=0 does not add id filter (sincePosition > 0 guard)', async () => {
    const db = createPushDb();
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/notifications?from=0',
      getInit()
    );
    const sel = db.selects.find((s) => s.sql.includes('FROM notification_queue'));
    expect(sel?.sql).not.toContain('nq.id > ?');
  });
});
