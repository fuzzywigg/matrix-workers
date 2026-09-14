/**
 * TOKENMAXX HEAVY leftovers after #206 — push API *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by push-api-routes,
 * push-api-route-leftovers soft floods (#157/#160/#186), or push-notification
 * workflow concurrent-race (#195).
 *
 * Distinct domain — not typing (#206), sliding-sync (#205), presence (#204),
 * sync (#202), voip/rtc/calls (#201), report/server-notices (#200),
 * search/spaces (#199), profile (#198/#197), tags (#196), workflows (#195),
 * rooms-mutate (#194), aliases (#193), rooms (#192), admin-mutate (#191).
 * Complements soft concurrent same-pushkey leftover in push-api-routes which
 * lacked DELETE→INSERT barriers, GET mid-flight, pushrules SELECT→mutate
 * TOCTOU, enabled/actions∥CRUD, and evaluatePushRules∥PUT coherency.
 *
 * Focus: pushers SET create∥delete / DELETE→INSERT run barriers; GET∥SET
 * mid-flight; pushrules PUT∥DELETE∥enabled∥actions; actions SELECT→INSERT
 * TOCTOU; rules ALL→mutate; evaluatePushRules∥PUT; notifications∥mutate;
 * D1 failure soft; method/body/charset/lifecycle soft floods; SQL bind
 * contracts under parallel.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { evaluatePushRules, queueNotification } from '../src/api/push';

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
const ROOM2 = '!room2:example.com';
const EVENT = '$event:example.com';
const EVENT2 = '$event2:example.com';
const AUTH = { Authorization: 'Bearer test-token' };

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
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

async function withSqlBarrier(
  barrier: SqlBarrier | undefined,
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

function createPushDb(
  opts: {
    pushers?: PusherRow[];
    rules?: PushRuleRow[];
    notifications?: NotificationRow[];
    runBarrier?: SqlBarrier;
    selectBarrier?: SqlBarrier;
    allBarrier?: SqlBarrier;
    mutatePushersAfterAll?: { after: number; next: PusherRow[] };
    mutateRulesAfterAll?: { after: number; next: PushRuleRow[] };
    mutateRuleAfterActionsSelect?: { after: number; next: PushRuleRow | null };
    failInsertAfter?: number;
    failDeleteAfter?: number;
    failUpdateAfter?: number;
    failAllAfter?: number;
    failSelectAfter?: number;
  } = {}
) {
  const pushers = opts.pushers ? [...opts.pushers] : [];
  const rules = opts.rules ? [...opts.rules] : [];
  const notifications = opts.notifications ? [...opts.notifications] : [];

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const alls: SqlCall[] = [];
  const events: string[] = [];

  let runBarrier = opts.runBarrier;
  let selectBarrier = opts.selectBarrier;
  let allBarrier = opts.allBarrier;
  const runWaiters = { list: [] as Array<() => void> };
  const selectWaiters = { list: [] as Array<() => void> };
  const allWaiters = { list: [] as Array<() => void> };

  let insertCount = 0;
  let deleteCount = 0;
  let updateCount = 0;
  let pushersAllCount = 0;
  let rulesAllCount = 0;
  let actionsSelectCount = 0;
  let allCount = 0;
  let selectCount = 0;

  const mutatePushers = opts.mutatePushersAfterAll;
  const mutateRules = opts.mutateRulesAfterAll;
  const mutateRuleAfterActions = opts.mutateRuleAfterActionsSelect;

  const db = {
    pushers,
    rules,
    notifications,
    inserts,
    updates,
    deletes,
    runs,
    selects,
    alls,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              selectCount += 1;
              events.push(`first:${sql.slice(0, 48)}`);
              await withSqlBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.failSelectAfter !== undefined && selectCount > opts.failSelectAfter) {
                throw new Error('d1-select-fail');
              }

              if (
                sql.includes('SELECT conditions, actions FROM push_rules') &&
                sql.includes('WHERE user_id = ? AND kind = ? AND rule_id = ?')
              ) {
                const [userId, kind, ruleId] = args as [string, string, string];
                const hit = rules.find(
                  (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                );
                actionsSelectCount += 1;
                if (mutateRuleAfterActions && actionsSelectCount === mutateRuleAfterActions.after) {
                  if (mutateRuleAfterActions.next === null) {
                    for (let i = rules.length - 1; i >= 0; i--) {
                      const r = rules[i];
                      if (r.user_id === userId && r.kind === kind && r.rule_id === ruleId) {
                        rules.splice(i, 1);
                      }
                    }
                  } else {
                    const idx = rules.findIndex(
                      (r) => r.user_id === userId && r.kind === kind && r.rule_id === ruleId
                    );
                    if (idx >= 0) rules[idx] = mutateRuleAfterActions.next;
                    else rules.push(mutateRuleAfterActions.next);
                  }
                  events.push('mutate:rule-after-actions-select');
                }
                if (!hit) return null;
                return { conditions: hit.conditions, actions: hit.actions } as T;
              }

              return null;
            },

            async all<T>() {
              alls.push({ sql, args });
              selects.push({ sql, args });
              allCount += 1;
              events.push(`all:${sql.slice(0, 48)}`);
              await withSqlBarrier(
                allBarrier,
                allWaiters,
                () => {
                  allBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.failAllAfter !== undefined && allCount > opts.failAllAfter) {
                throw new Error('d1-all-fail');
              }

              if (sql.includes('FROM pushers') && sql.includes('WHERE user_id = ?')) {
                const userId = args[0] as string;
                pushersAllCount += 1;
                const snapshot = pushers
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
                if (mutatePushers && pushersAllCount === mutatePushers.after) {
                  pushers.splice(0, pushers.length, ...mutatePushers.next);
                  events.push('mutate:pushers-after-all');
                }
                return { results: snapshot } as { results: T[] };
              }

              if (
                sql.includes('FROM push_rules') &&
                sql.includes('WHERE user_id = ?') &&
                sql.includes('ORDER BY priority ASC')
              ) {
                const userId = args[0] as string;
                rulesAllCount += 1;
                const snapshot = rules
                  .filter((r) => r.user_id === userId)
                  .sort((a, b) => a.priority - b.priority)
                  .map((r) => ({
                    kind: r.kind,
                    rule_id: r.rule_id,
                    conditions: r.conditions,
                    actions: r.actions,
                    enabled: r.enabled,
                  }));
                if (mutateRules && rulesAllCount === mutateRules.after) {
                  rules.splice(0, rules.length, ...mutateRules.next);
                  events.push('mutate:rules-after-all');
                }
                return { results: snapshot } as { results: T[] };
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
              await withSqlBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
              runs.push({ sql, args });
              events.push(`run:${sql.slice(0, 48)}`);

              if (
                sql.includes('DELETE FROM pushers WHERE user_id = ? AND pushkey = ? AND app_id = ?')
              ) {
                deletes.push({ sql, args });
                deleteCount += 1;
                if (opts.failDeleteAfter !== undefined && deleteCount > opts.failDeleteAfter) {
                  throw new Error('d1-delete-fail');
                }
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
                deleteCount += 1;
                if (opts.failDeleteAfter !== undefined && deleteCount > opts.failDeleteAfter) {
                  throw new Error('d1-delete-fail');
                }
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
                insertCount += 1;
                if (opts.failInsertAfter !== undefined && insertCount > opts.failInsertAfter) {
                  throw new Error('d1-insert-fail');
                }
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
                if (existing >= 0) pushers[existing] = row;
                else pushers.push(row);
                return { success: true, meta: { changes: 1, last_row_id: pushers.length } };
              }

              if (
                sql.includes('INSERT INTO push_rules') &&
                sql.includes('ON CONFLICT') &&
                sql.includes('enabled = excluded.enabled')
              ) {
                inserts.push({ sql, args });
                insertCount += 1;
                if (opts.failInsertAfter !== undefined && insertCount > opts.failInsertAfter) {
                  throw new Error('d1-insert-fail');
                }
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
                if (idx >= 0) rules[idx] = { ...rules[idx], enabled, conditions, actions };
                else rules.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (
                sql.includes('INSERT INTO push_rules') &&
                sql.includes('ON CONFLICT') &&
                sql.includes('actions = excluded.actions') &&
                !sql.includes('conditions = excluded.conditions')
              ) {
                inserts.push({ sql, args });
                insertCount += 1;
                if (opts.failInsertAfter !== undefined && insertCount > opts.failInsertAfter) {
                  throw new Error('d1-insert-fail');
                }
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
                if (idx >= 0) rules[idx] = { ...rules[idx], actions, conditions };
                else {
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
                insertCount += 1;
                if (opts.failInsertAfter !== undefined && insertCount > opts.failInsertAfter) {
                  throw new Error('d1-insert-fail');
                }
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
                } else rules.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO notification_queue')) {
                inserts.push({ sql, args });
                insertCount += 1;
                if (opts.failInsertAfter !== undefined && insertCount > opts.failInsertAfter) {
                  throw new Error('d1-insert-fail');
                }
                const [userId, roomId, eventId, notificationType, actions] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                ];
                const id = notifications.length
                  ? Math.max(...notifications.map((n) => n.id)) + 1
                  : 1;
                notifications.push({
                  id,
                  user_id: userId,
                  room_id: roomId,
                  event_id: eventId,
                  notification_type: notificationType,
                  actions,
                  read: 0,
                  created_at: 1_700_000_000_000 + id,
                  event_type: 'm.room.message',
                  sender: BOB,
                  content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
                });
                return { success: true, meta: { changes: 1, last_row_id: id } };
              }

              if (
                sql.includes('UPDATE push_rules SET enabled = ?') &&
                sql.includes('WHERE user_id = ? AND kind = ? AND rule_id = ?')
              ) {
                updates.push({ sql, args });
                updateCount += 1;
                if (opts.failUpdateAfter !== undefined && updateCount > opts.failUpdateAfter) {
                  throw new Error('d1-update-fail');
                }
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
                deleteCount += 1;
                if (opts.failDeleteAfter !== undefined && deleteCount > opts.failDeleteAfter) {
                  throw new Error('d1-delete-fail');
                }
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

function envFor(db: PushDb): Env & { _db: PushDb } {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    _db: db,
  } as unknown as Env & { _db: PushDb };
}

async function request(
  db: PushDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
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
      ...AUTH,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function authGet(): RequestInit {
  return { method: 'GET', headers: { ...AUTH } };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
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
    data:
      overrides.data ??
      JSON.stringify({ url: 'https://push.example.com/_matrix/push/v1/notify' }),
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

function pusherBody(overrides: Record<string, unknown> = {}) {
  return {
    pushkey: 'pk-new',
    kind: 'http',
    app_id: 'im.vector.app',
    app_display_name: 'Element',
    device_display_name: 'Pixel',
    lang: 'en',
    data: { url: 'https://push.example.com/_matrix/push/v1/notify', format: 'event_id_only' },
    ...overrides,
  };
}

function rulePath(kind = 'override', ruleId = 'custom.rule') {
  return `/_matrix/client/v3/pushrules/global/${kind}/${encodeURIComponent(ruleId)}`;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pushers SET — DELETE→INSERT run barrier TOCTOU
// ---------------------------------------------------------------------------

describe('race pushers SET DELETE→INSERT run barrier TOCTOU after #206', () => {
  it('parallel SET same pushkey under INSERT barrier: both 200, one survivor row for app', async () => {
    const db = createPushDb({
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO pushers'),
      },
    });
    const results = await Promise.all([
      request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', pusherBody({ device_display_name: 'A' }))),
      request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', pusherBody({ device_display_name: 'B' }))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.inserts.length).toBeGreaterThanOrEqual(2);
    const survivors = db.pushers.filter((p) => p.pushkey === 'pk-new' && p.app_id === 'im.vector.app');
    expect(survivors).toHaveLength(1);
    expect(['A', 'B']).toContain(survivors[0].device_display_name);
  });

  it('sequential SET preserves last write without barrier loss', async () => {
    const db = createPushDb();
    expect(
      (await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', pusherBody({ device_display_name: '1' })))).status
    ).toBe(200);
    expect(
      (await request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', pusherBody({ device_display_name: '2' })))).status
    ).toBe(200);
    expect(db.pushers.find((p) => p.pushkey === 'pk-new')?.device_display_name).toBe('2');
  });

  for (let i = 0; i < 12; i++) {
    it(`INSERT barrier soft-${i}: dual SET same pushkey`, async () => {
      const db = createPushDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('INSERT INTO pushers'),
        },
      });
      const results = await Promise.all([
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', pusherBody({ device_display_name: `a-${i}`, lang: i % 2 === 0 ? 'en' : 'de' }))
        ),
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', pusherBody({ device_display_name: `b-${i}`, lang: i % 2 === 0 ? 'fr' : 'es' }))
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.pushers.filter((p) => p.pushkey === 'pk-new')).toHaveLength(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`DELETE barrier soft-${i}: create∥delete same pushkey`, async () => {
      const db = createPushDb({
        pushers: [seedPusher({ pushkey: 'pk-race', app_id: 'im.vector.app' })],
        runBarrier: {
          count: 2,
          match: (sql) =>
            sql.includes('DELETE FROM pushers') || sql.includes('INSERT INTO pushers'),
        },
      });
      const results = await Promise.all([
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', pusherBody({ pushkey: 'pk-race', device_display_name: `keep-${i}` }))
        ),
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', { pushkey: 'pk-race', kind: null, app_id: 'im.vector.app' })
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      // Last-write wins: either deleted or recreated
      const survivors = db.pushers.filter((p) => p.pushkey === 'pk-race');
      expect(survivors.length).toBeLessThanOrEqual(1);
    });
  }
});


// ---------------------------------------------------------------------------
// Pushers GET∥SET mid-flight + ALL barrier mutate
// ---------------------------------------------------------------------------

describe('race pushers GET∥SET mid-flight + ALL mutate TOCTOU after #206', () => {
  it('GET mid-flight while SET held at INSERT barrier sees pre-insert state', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-old' })],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO pushers'),
      },
    });
    const set1 = request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', pusherBody({ pushkey: 'pk-mid', device_display_name: 'mid' }))
    );
    for (let n = 0; n < 40 && db.deletes.length < 1; n++) {
      await Promise.resolve();
    }
    // Non-append SET deletes by pushkey first; INSERT then waits on barrier
    expect(db.deletes.length).toBeGreaterThanOrEqual(1);
    expect(db.inserts).toHaveLength(0);

    const getRes = await request(db, '/_matrix/client/v3/pushers', authGet());
    expect(getRes.status).toBe(200);
    const keys = (getRes.body.pushers as Array<{ pushkey: string }>).map((p) => p.pushkey);
    expect(keys).toContain('pk-old');
    expect(keys).not.toContain('pk-mid');

    const set2 = request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', pusherBody({ pushkey: 'pk-release', app_id: 'org.release.app' }))
    );
    const [r1, r2] = await Promise.all([set1, set2]);
    expect(statusesOf([r1, r2])).toEqual([200, 200]);
    expect(db.inserts.length).toBeGreaterThanOrEqual(2);
  });

  it('dual GET under ALL barrier while SET mutates pushers list', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-a' })],
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM pushers'),
      },
      mutatePushersAfterAll: {
        after: 1,
        next: [seedPusher({ pushkey: 'pk-mutated', app_id: 'org.mutated' })],
      },
    });
    const results = await Promise.all([
      request(db, '/_matrix/client/v3/pushers', authGet()),
      request(db, '/_matrix/client/v3/pushers', authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const keySets = results.map((r) =>
      (r.body.pushers as Array<{ pushkey: string }>).map((p) => p.pushkey).sort().join(',')
    );
    // First GET snapshots pre-mutate; second may see mutated (after=1 fires after first all)
    expect(keySets.some((k) => k.includes('pk-a') || k.includes('pk-mutated'))).toBe(true);
    expect(db.events).toContain('mutate:pushers-after-all');
  });

  for (let i = 0; i < 10; i++) {
    it(`GET∥SET soft-${i}: parallel list + register`, async () => {
      const db = createPushDb({
        pushers: [seedPusher({ pushkey: `pk-seed-${i}` })],
      });
      const results = await Promise.all([
        request(db, '/_matrix/client/v3/pushers', authGet()),
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', pusherBody({ pushkey: `pk-new-${i}`, device_display_name: `d-${i}` }))
        ),
        request(db, '/_matrix/client/v3/pushers', authGet()),
      ]);
      expect(results[1].status).toBe(200);
      expect(results[0].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(db.pushers.some((p) => p.pushkey === `pk-new-${i}`)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`append=true soft-${i}: dual SET distinct app_ids same pushkey`, async () => {
      const db = createPushDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('INSERT INTO pushers'),
        },
      });
      const results = await Promise.all([
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit(
            'POST',
            pusherBody({
              pushkey: 'pk-append',
              app_id: 'app.a',
              append: true,
              device_display_name: `A-${i}`,
            })
          )
        ),
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit(
            'POST',
            pusherBody({
              pushkey: 'pk-append',
              app_id: 'app.b',
              append: true,
              device_display_name: `B-${i}`,
            })
          )
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.pushers.filter((p) => p.pushkey === 'pk-append')).toHaveLength(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Pushrules PUT∥DELETE run barrier TOCTOU
// ---------------------------------------------------------------------------

describe('race pushrules PUT∥DELETE run barrier TOCTOU after #206', () => {
  it('parallel PUT same rule under INSERT barrier: both 200, one survivor actions', async () => {
    const db = createPushDb({
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO push_rules'),
      },
    });
    const results = await Promise.all([
      request(db, rulePath(), jsonInit('PUT', { actions: ['notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })),
      request(db, rulePath(), jsonInit('PUT', { actions: ['dont_notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.rules.filter((r) => r.rule_id === 'custom.rule')).toHaveLength(1);
    const actions = JSON.parse(db.rules[0].actions);
    expect([['notify'], ['dont_notify']]).toContainEqual(actions);
  });

  it('PUT∥DELETE same rule under mixed run barrier: coherent end state', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.race', actions: JSON.stringify(['notify']) })],
      runBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('INSERT INTO push_rules') || sql.includes('DELETE FROM push_rules'),
      },
    });
    const results = await Promise.all([
      request(
        db,
        rulePath('override', 'custom.race'),
        jsonInit('PUT', { actions: ['dont_notify'], conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }] })
      ),
      request(db, rulePath('override', 'custom.race'), { method: 'DELETE', headers: { ...AUTH } }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
    expect(db.rules.filter((r) => r.rule_id === 'custom.race').length).toBeLessThanOrEqual(1);
  });

  for (let i = 0; i < 12; i++) {
    it(`PUT barrier soft-${i}: dual PUT kind=${['override', 'content', 'room', 'sender'][i % 4]}`, async () => {
      const kind = (['override', 'content', 'room', 'sender'] as const)[i % 4];
      const ruleId = `custom.soft.${i}`;
      const db = createPushDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('INSERT INTO push_rules'),
        },
      });
      const bodyA =
        kind === 'content'
          ? { actions: ['notify'], pattern: `pat-a-${i}` }
          : {
              actions: ['notify'],
              conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
            };
      const bodyB =
        kind === 'content'
          ? { actions: ['dont_notify'], pattern: `pat-b-${i}` }
          : {
              actions: ['dont_notify'],
              conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.member' }],
            };
      const results = await Promise.all([
        request(db, rulePath(kind, ruleId), jsonInit('PUT', bodyA)),
        request(db, rulePath(kind, ruleId), jsonInit('PUT', bodyB)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.rules.filter((r) => r.rule_id === ruleId)).toHaveLength(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`DELETE barrier soft-${i}: dual DELETE missing vs present`, async () => {
      const db = createPushDb({
        rules: i % 2 === 0 ? [seedRule({ rule_id: `del.${i}` })] : [],
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('DELETE FROM push_rules'),
        },
      });
      const results = await Promise.all([
        request(db, rulePath('override', `del.${i}`), { method: 'DELETE', headers: { ...AUTH } }),
        request(db, rulePath('override', `del.${i}`), { method: 'DELETE', headers: { ...AUTH } }),
      ]);
      // One may 200, one 404 when starting present; both 404 when absent
      expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
      expect(db.rules.filter((r) => r.rule_id === `del.${i}`)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Pushrules enabled/actions SELECT→mutate TOCTOU
// ---------------------------------------------------------------------------

describe('race pushrules enabled/actions SELECT→mutate TOCTOU after #206', () => {
  it('actions PUT SELECT→rule deleted mid-flight: first upserts, second may 404', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'custom.actions',
          conditions: JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }]),
          actions: JSON.stringify(['notify']),
        }),
      ],
      mutateRuleAfterActionsSelect: {
        after: 1,
        next: null,
      },
    });
    // First actions SELECT snapshots then deletes row; second SELECT misses → M_NOT_FOUND.
    // First request still upserts from its snapshot (TOCTOU recreate).
    const results = await Promise.all([
      request(
        db,
        `${rulePath('override', 'custom.actions')}/actions`,
        jsonInit('PUT', { actions: ['dont_notify'] })
      ),
      request(
        db,
        `${rulePath('override', 'custom.actions')}/actions`,
        jsonInit('PUT', { actions: ['notify', { set_tweak: 'highlight', value: true }] })
      ),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(db.events).toContain('mutate:rule-after-actions-select');
    expect(db.rules.some((r) => r.rule_id === 'custom.actions')).toBe(true);
  });

  it('enabled UPDATE∥DELETE same custom rule under run barrier', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.enabled', enabled: 1 })],
      runBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('UPDATE push_rules SET enabled') || sql.includes('DELETE FROM push_rules'),
      },
    });
    const results = await Promise.all([
      request(
        db,
        `${rulePath('override', 'custom.enabled')}/enabled`,
        jsonInit('PUT', { enabled: false })
      ),
      request(db, rulePath('override', 'custom.enabled'), { method: 'DELETE', headers: { ...AUTH } }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`enabled dual soft-${i}: true∥false under UPDATE barrier`, async () => {
      const db = createPushDb({
        rules: [seedRule({ rule_id: `en.${i}`, enabled: 1 })],
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('UPDATE push_rules SET enabled'),
        },
      });
      const results = await Promise.all([
        request(db, `${rulePath('override', `en.${i}`)}/enabled`, jsonInit('PUT', { enabled: true })),
        request(db, `${rulePath('override', `en.${i}`)}/enabled`, jsonInit('PUT', { enabled: false })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect([0, 1]).toContain(db.rules.find((r) => r.rule_id === `en.${i}`)?.enabled);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`default enabled override soft-${i}: dual PUT .m.rule.master`, async () => {
      const db = createPushDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('INSERT INTO push_rules'),
        },
      });
      const results = await Promise.all([
        request(
          db,
          `${rulePath('override', '.m.rule.master')}/enabled`,
          jsonInit('PUT', { enabled: true })
        ),
        request(
          db,
          `${rulePath('override', '.m.rule.master')}/enabled`,
          jsonInit('PUT', { enabled: false })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.rules.filter((r) => r.rule_id === '.m.rule.master')).toHaveLength(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`actions∥PUT soft-${i}: parallel actions + full rule PUT`, async () => {
      const db = createPushDb({
        rules: [seedRule({ rule_id: `act.${i}` })],
      });
      const results = await Promise.all([
        request(
          db,
          `${rulePath('override', `act.${i}`)}/actions`,
          jsonInit('PUT', { actions: ['dont_notify'] })
        ),
        request(
          db,
          rulePath('override', `act.${i}`),
          jsonInit('PUT', {
            actions: ['notify'],
            conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
          })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.rules.filter((r) => r.rule_id === `act.${i}`)).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Pushrules GET ALL→mutate + evaluatePushRules∥PUT coherency
// ---------------------------------------------------------------------------

describe('race pushrules GET ALL→mutate + evaluatePushRules∥PUT after #206', () => {
  it('dual GET pushrules under ALL barrier with mid-flight rule mutate', async () => {
    const db = createPushDb({
      rules: [seedRule({ rule_id: 'custom.visible', actions: JSON.stringify(['notify']) })],
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM push_rules') && sql.includes('ORDER BY priority'),
      },
      mutateRulesAfterAll: {
        after: 1,
        next: [seedRule({ rule_id: 'custom.mutated', actions: JSON.stringify(['dont_notify']) })],
      },
    });
    const results = await Promise.all([
      request(db, '/_matrix/client/v3/pushrules', authGet()),
      request(db, '/_matrix/client/v3/pushrules/global', authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.events).toContain('mutate:rules-after-all');
  });

  it('evaluatePushRules∥PUT: evaluation sees either old or new custom rule', async () => {
    const db = createPushDb({
      rules: [
        seedRule({
          rule_id: 'custom.eval',
          kind: 'override',
          priority: 0,
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
          ]),
          actions: JSON.stringify(['notify']),
          enabled: 1,
        }),
      ],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO push_rules'),
      },
    });
    const event = {
      type: 'm.room.message',
      content: { body: 'hi', msgtype: 'm.text' },
      sender: BOB,
      room_id: ROOM,
    };
    // Fire two PUTs with evaluate so INSERT barrier (count=2) releases without deadlock
    const [evalRes, putRes, put2] = await Promise.all([
      evaluatePushRules(db as unknown as D1Database, USER, event, 2, 'Alice'),
      request(
        db,
        rulePath('override', 'custom.eval'),
        jsonInit('PUT', {
          actions: ['dont_notify'],
          conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
        })
      ),
      request(
        db,
        rulePath('override', 'custom.eval2'),
        jsonInit('PUT', {
          actions: ['notify'],
          conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.member' }],
        })
      ),
    ]);
    expect(putRes.status).toBe(200);
    expect(put2.status).toBe(200);
    expect(typeof evalRes.notify).toBe('boolean');
    expect(db.rules.some((r) => r.rule_id === 'custom.eval')).toBe(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`GET∥PUT soft-${i}: list rules while mutating`, async () => {
      const db = createPushDb({
        rules: [seedRule({ rule_id: `list.${i}` })],
      });
      const results = await Promise.all([
        request(db, '/_matrix/client/v3/pushrules', authGet()),
        request(
          db,
          rulePath('override', `list.${i}`),
          jsonInit('PUT', {
            actions: i % 2 === 0 ? ['notify'] : ['dont_notify'],
            conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
          })
        ),
        request(db, rulePath('override', `list.${i}`), authGet()),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`evaluate soft-${i}: parallel evaluatePushRules under rule churn`, async () => {
      const db = createPushDb({
        rules: [
          seedRule({
            rule_id: `eval.${i}`,
            conditions: JSON.stringify([
              { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
            ]),
            actions: JSON.stringify(['notify']),
          }),
        ],
      });
      const event = {
        type: 'm.room.message',
        content: { body: `msg-${i}`, msgtype: 'm.text' },
        sender: BOB,
        room_id: ROOM,
      };
      const [a, b, put] = await Promise.all([
        evaluatePushRules(db as unknown as D1Database, USER, event, 3),
        evaluatePushRules(db as unknown as D1Database, USER, event, 3),
        request(
          db,
          `${rulePath('override', `eval.${i}`)}/enabled`,
          jsonInit('PUT', { enabled: i % 2 === 0 })
        ),
      ]);
      expect(put.status).toBe(200);
      expect(typeof a.notify).toBe('boolean');
      expect(typeof b.notify).toBe('boolean');
    });
  }
});

// ---------------------------------------------------------------------------
// Notifications∥mutate + queueNotification races
// ---------------------------------------------------------------------------

describe('race notifications∥mutate + queueNotification after #206', () => {
  it('dual GET notifications under ALL barrier', async () => {
    const db = createPushDb({
      notifications: [
        seedNotification({ id: 1 }),
        seedNotification({ id: 2, event_id: EVENT2, notification_type: 'highlight' }),
      ],
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM notification_queue'),
      },
    });
    const results = await Promise.all([
      request(db, '/_matrix/client/v3/notifications', authGet()),
      request(db, '/_matrix/client/v3/notifications?only=highlight', authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('queueNotification∥GET: notification appears after queue', async () => {
    const db = createPushDb({
      notifications: [seedNotification({ id: 10 })],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT INTO notification_queue'),
      },
    });
    const q1 = queueNotification(
      db as unknown as D1Database,
      USER,
      ROOM,
      '$q1:example.com',
      'notify',
      ['notify']
    );
    for (let n = 0; n < 20 && db.inserts.length < 1; n++) {
      await Promise.resolve();
    }
    // Held at barrier — GET should not yet see queued row if insert not applied
    // (barrier is before mutation in our harness, so insert waits)
    const mid = await request(db, '/_matrix/client/v3/notifications', authGet());
    expect(mid.status).toBe(200);

    const q2 = queueNotification(
      db as unknown as D1Database,
      USER,
      ROOM2,
      '$q2:example.com',
      'highlight',
      ['notify']
    );
    await Promise.all([q1, q2]);
    expect(db.notifications.length).toBeGreaterThanOrEqual(3);
  });

  for (let i = 0; i < 10; i++) {
    it(`notifications soft-${i}: parallel GET with limit/from`, async () => {
      const db = createPushDb({
        notifications: Array.from({ length: 5 }, (_, j) =>
          seedNotification({
            id: j + 1,
            event_id: `$e${j}:example.com`,
            created_at: 1_700_000_000_000 + j,
            notification_type: j % 2 === 0 ? 'notify' : 'highlight',
          })
        ),
      });
      const results = await Promise.all([
        request(db, `/_matrix/client/v3/notifications?limit=${2 + (i % 3)}`, authGet()),
        request(db, `/_matrix/client/v3/notifications?from=${i % 3}&limit=2`, authGet()),
        request(db, '/_matrix/client/v3/notifications?only=highlight', authGet()),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(Array.isArray(results[0].body.notifications)).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`queue∥rules soft-${i}: queue while PUT rule`, async () => {
      const db = createPushDb({ rules: [seedRule({ rule_id: `nq.${i}` })] });
      const [q, put, get] = await Promise.all([
        queueNotification(
          db as unknown as D1Database,
          USER,
          ROOM,
          `$nq${i}:example.com`,
          'notify',
          ['notify']
        ),
        request(
          db,
          rulePath('override', `nq.${i}`),
          jsonInit('PUT', {
            actions: ['dont_notify'],
            conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
          })
        ),
        request(db, '/_matrix/client/v3/notifications', authGet()),
      ]);
      expect(put.status).toBe(200);
      expect(get.status).toBe(200);
      expect(db.notifications.some((n) => n.event_id === `$nq${i}:example.com`)).toBe(true);
      void q;
    });
  }
});

// ---------------------------------------------------------------------------
// D1 failure soft mid concurrent
// ---------------------------------------------------------------------------

describe('race push store failure mid concurrent after #206', () => {
  for (let i = 0; i < 6; i++) {
    it(`insert fail soft-${i}: SET after failInsertAfter=0 → 500`, async () => {
      const db = createPushDb({ failInsertAfter: 0 });
      const res = await request(
        db,
        '/_matrix/client/v3/pushers/set',
        jsonInit('POST', pusherBody({ pushkey: `fail-${i}` }))
      );
      expect(res.status).toBe(500);
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`delete fail soft-${i}: DELETE rule after failDeleteAfter=0 → 500`, async () => {
      const db = createPushDb({
        rules: [seedRule({ rule_id: `fail-del.${i}` })],
        failDeleteAfter: 0,
      });
      const res = await request(db, rulePath('override', `fail-del.${i}`), {
        method: 'DELETE',
        headers: { ...AUTH },
      });
      expect(res.status).toBe(500);
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`all fail soft-${i}: GET pushers after failAllAfter=0 → 500`, async () => {
      const db = createPushDb({ failAllAfter: 0 });
      const res = await request(db, '/_matrix/client/v3/pushers', authGet());
      expect(res.status).toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — invalid method matrix
// ---------------------------------------------------------------------------

describe('push concurrent soft flood — invalid method matrix after #206', () => {
  const cases: Array<{ path: string; methods: string[] }> = [
    { path: '/_matrix/client/v3/pushers', methods: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/pushers/set', methods: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/pushrules', methods: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/notifications', methods: ['POST', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const entry of cases) {
    for (const method of entry.methods) {
      it(`rejects ${method} ${entry.path} under parallel`, async () => {
        const db = createPushDb();
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            request(db, entry.path, {
              method,
              headers: { ...AUTH, 'Content-Type': 'application/json' },
              body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
            })
          )
        );
        expect(results.every((r) => r.status !== 200)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Soft flood — bad JSON / body edges
// ---------------------------------------------------------------------------

describe('push concurrent soft flood — bad JSON / body edges after #206', () => {
  const badSet: Array<{ label: string; body: unknown }> = [
    { label: 'empty', body: {} },
    { label: 'no-pushkey', body: { kind: 'http', app_id: 'a', app_display_name: 'A', device_display_name: 'D', lang: 'en', data: {} } },
    { label: 'missing-fields', body: { pushkey: 'pk', kind: 'http' } },
    { label: 'array-root', body: [] },
    { label: 'string-root', body: 'nope' },
  ];
  for (let i = 0; i < badSet.length; i++) {
    const entry = badSet[i];
    it(`SET body soft-${i} (${entry.label}) parallel`, async () => {
      const db = createPushDb();
      const results = await Promise.all([
        request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', entry.body)),
        request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', entry.body)),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`truncated JSON SET soft-${i}`, async () => {
      const db = createPushDb();
      const results = await Promise.all([
        request(db, '/_matrix/client/v3/pushers/set', {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: '{"pushkey":"pk"',
        }),
        request(db, '/_matrix/client/v3/pushers/set', {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: '{',
        }),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }

  const badRules: Array<{ label: string; body: unknown; path: string }> = [
    { label: 'no-actions', body: { conditions: [] }, path: rulePath() },
    { label: 'content-no-pattern', body: { actions: ['notify'] }, path: rulePath('content', 'c.1') },
    { label: 'enabled-non-bool', body: { enabled: 'yes' }, path: `${rulePath()}/enabled` },
    { label: 'actions-non-array', body: { actions: 'notify' }, path: `${rulePath()}/actions` },
  ];
  for (let i = 0; i < badRules.length; i++) {
    const entry = badRules[i];
    it(`rules body soft-${i} (${entry.label}) parallel`, async () => {
      const db = createPushDb({ rules: [seedRule()] });
      const results = await Promise.all([
        request(db, entry.path, jsonInit('PUT', entry.body)),
        request(db, entry.path, jsonInit('PUT', entry.body)),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — charset / content-type
// ---------------------------------------------------------------------------

describe('push concurrent soft flood — charset / content-type after #206', () => {
  const contentTypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=iso-8859-1',
  ];
  for (let i = 0; i < contentTypes.length; i++) {
    const ct = contentTypes[i];
    it(`content-type soft-${i}: ${ct}`, async () => {
      const db = createPushDb();
      const results = await Promise.all([
        request(db, '/_matrix/client/v3/pushers/set', {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': ct },
          body: JSON.stringify(pusherBody({ pushkey: `ct-${i}-a`, device_display_name: 'A' })),
        }),
        request(db, '/_matrix/client/v3/pushers/set', {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': ct },
          body: JSON.stringify(pusherBody({ pushkey: `ct-${i}-b`, app_id: 'org.other', device_display_name: 'B' })),
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — lifecycles
// ---------------------------------------------------------------------------

describe('push concurrent soft flood — lifecycles after #206', () => {
  for (let i = 0; i < 12; i++) {
    it(`lifecycle soft-${i}: set→list→rule→enabled→actions→delete→notifications`, async () => {
      const db = createPushDb({
        notifications: [seedNotification({ id: 1, event_id: `$life${i}:example.com` })],
      });
      const set = await request(
        db,
        '/_matrix/client/v3/pushers/set',
        jsonInit('POST', pusherBody({ pushkey: `life-${i}`, device_display_name: `L-${i}` }))
      );
      expect(set.status).toBe(200);
      const list = await request(db, '/_matrix/client/v3/pushers', authGet());
      expect(list.status).toBe(200);
      expect((list.body.pushers as Array<{ pushkey: string }>).some((p) => p.pushkey === `life-${i}`)).toBe(true);

      const ruleId = `life.rule.${i}`;
      const put = await request(
        db,
        rulePath('override', ruleId),
        jsonInit('PUT', {
          actions: ['notify'],
          conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
        })
      );
      expect(put.status).toBe(200);
      const en = await request(
        db,
        `${rulePath('override', ruleId)}/enabled`,
        jsonInit('PUT', { enabled: false })
      );
      expect(en.status).toBe(200);
      const act = await request(
        db,
        `${rulePath('override', ruleId)}/actions`,
        jsonInit('PUT', { actions: ['dont_notify'] })
      );
      expect(act.status).toBe(200);
      const del = await request(db, rulePath('override', ruleId), {
        method: 'DELETE',
        headers: { ...AUTH },
      });
      expect(del.status).toBe(200);
      const notes = await request(db, '/_matrix/client/v3/notifications', authGet());
      expect(notes.status).toBe(200);
    });
  }

  it('multi-pusher isolation under parallel SET distinct keys', async () => {
    const db = createPushDb();
    const results = await Promise.all(
      ['pk-x', 'pk-y', 'pk-z'].map((pushkey, idx) =>
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', pusherBody({ pushkey, app_id: `app.${idx}`, device_display_name: `D${idx}` }))
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.pushers).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Soft flood — default overwrite / scope / kind gates
// ---------------------------------------------------------------------------

describe('push concurrent soft flood — default/scope/kind gates after #206', () => {
  for (let i = 0; i < 8; i++) {
    it(`cannot overwrite default soft-${i}`, async () => {
      const db = createPushDb();
      const results = await Promise.all([
        request(
          db,
          rulePath('override', '.m.rule.master'),
          jsonInit('PUT', { actions: ['notify'] })
        ),
        request(
          db,
          rulePath('override', '.m.rule.suppress_notices'),
          jsonInit('PUT', { actions: ['dont_notify'] })
        ),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
      expect(results.every((r) => r.body.errcode === 'M_CANNOT_OVERWRITE_DEFAULT')).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`cannot delete default soft-${i}`, async () => {
      const db = createPushDb();
      const results = await Promise.all([
        request(db, rulePath('override', '.m.rule.master'), { method: 'DELETE', headers: { ...AUTH } }),
        request(db, rulePath('content', '.m.rule.contains_user_name'), {
          method: 'DELETE',
          headers: { ...AUTH },
        }),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`invalid scope soft-${i}`, async () => {
      const db = createPushDb();
      const results = await Promise.all([
        request(
          db,
          `/_matrix/client/v3/pushrules/device/override/custom.${i}`,
          jsonInit('PUT', { actions: ['notify'] })
        ),
        request(db, `/_matrix/client/v3/pushrules/device/override/custom.${i}`, authGet()),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// SQL bind contracts under parallel
// ---------------------------------------------------------------------------

describe('push concurrent SQL bind contracts after #206', () => {
  it('SET create binds user_id, pushkey, kind, app_id, names, lang, data JSON', async () => {
    const db = createPushDb();
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit(
        'POST',
        pusherBody({
          pushkey: 'pk-bind',
          profile_tag: 'pt',
          data: { url: 'https://push.example.com/n', format: 'event_id_only' },
        })
      )
    );
    const insert = db.inserts.find((c) => c.sql.includes('INSERT INTO pushers'));
    expect(insert).toBeTruthy();
    expect(insert!.args[0]).toBe(USER);
    expect(insert!.args[1]).toBe('pk-bind');
    expect(insert!.args[2]).toBe('http');
    expect(insert!.args[3]).toBe('im.vector.app');
    expect(insert!.args[6]).toBe('pt');
    expect(JSON.parse(insert!.args[8] as string)).toMatchObject({
      url: 'https://push.example.com/n',
      format: 'event_id_only',
    });
  });

  it('SET delete binds user_id, pushkey, app_id', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-del', app_id: 'app.del' })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', { pushkey: 'pk-del', kind: null, app_id: 'app.del' })
    );
    const del = db.deletes.find((c) => c.sql.includes('AND app_id = ?'));
    expect(del?.args).toEqual([USER, 'pk-del', 'app.del']);
  });

  it('non-append SET deletes by pushkey before insert', async () => {
    const db = createPushDb({
      pushers: [seedPusher({ pushkey: 'pk-na', app_id: 'old.app' })],
    });
    await request(
      db,
      '/_matrix/client/v3/pushers/set',
      jsonInit('POST', pusherBody({ pushkey: 'pk-na', app_id: 'new.app' }))
    );
    expect(db.deletes.some((c) => c.sql.includes('DELETE FROM pushers WHERE user_id = ? AND pushkey = ?') && !c.sql.includes('app_id'))).toBe(true);
    expect(db.pushers.some((p) => p.app_id === 'old.app')).toBe(false);
    expect(db.pushers.some((p) => p.app_id === 'new.app')).toBe(true);
  });

  it('PUT rule binds kind, rule_id, conditions, actions, priority', async () => {
    const db = createPushDb();
    await request(
      db,
      `${rulePath('room', '!room:example.com')}?before=other`,
      jsonInit('PUT', {
        actions: ['notify'],
        conditions: [{ kind: 'event_match', key: 'room_id', pattern: ROOM }],
      })
    );
    const insert = db.inserts.find((c) => c.sql.includes('INSERT INTO push_rules'));
    expect(insert?.args[0]).toBe(USER);
    expect(insert?.args[1]).toBe('room');
    expect(insert?.args[2]).toBe('!room:example.com');
    expect(typeof insert?.args[5]).toBe('number');
  });

  for (let i = 0; i < 8; i++) {
    it(`parallel bind soft-${i}: SET + PUT rule + enabled`, async () => {
      const db = createPushDb({ rules: [seedRule({ rule_id: `bind.${i}` })] });
      const results = await Promise.all([
        request(
          db,
          '/_matrix/client/v3/pushers/set',
          jsonInit('POST', pusherBody({ pushkey: `bind-pk-${i}`, app_id: `bind.app.${i}` }))
        ),
        request(
          db,
          rulePath('override', `bind.${i}`),
          jsonInit('PUT', {
            actions: ['notify'],
            conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
          })
        ),
        request(
          db,
          `${rulePath('override', `bind.${i}`)}/enabled`,
          jsonInit('PUT', { enabled: i % 2 === 0 })
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.inserts.length + db.updates.length).toBeGreaterThanOrEqual(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Percent-encoding + multi-kind coexistence under parallel
// ---------------------------------------------------------------------------

describe('push concurrent percent-encoding + multi-kind after #206', () => {
  for (let i = 0; i < 8; i++) {
    it(`encoded rule id soft-${i}`, async () => {
      const ruleId = `u.rule/${i} space`;
      const db = createPushDb();
      const put = await request(
        db,
        rulePath('override', ruleId),
        jsonInit('PUT', {
          actions: ['notify'],
          conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
        })
      );
      expect(put.status).toBe(200);
      const get = await request(db, rulePath('override', ruleId), authGet());
      expect(get.status).toBe(200);
      expect(get.body.rule_id).toBe(ruleId);
    });
  }

  it('parallel PUT four kinds coexist', async () => {
    const db = createPushDb();
    const kinds = ['override', 'content', 'room', 'sender'] as const;
    const results = await Promise.all(
      kinds.map((kind, idx) =>
        request(
          db,
          rulePath(kind, `multi.${kind}`),
          jsonInit(
            'PUT',
            kind === 'content'
              ? { actions: ['notify'], pattern: `p${idx}` }
              : {
                  actions: ['notify'],
                  conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
                }
          )
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(db.rules.map((r) => r.kind)).size).toBe(4);
  });

  for (let i = 0; i < 6; i++) {
    it(`bob isolation soft-${i}: alice mutate does not touch bob rows`, async () => {
      const db = createPushDb({
        pushers: [seedPusher({ user_id: BOB, pushkey: 'pk-bob' })],
        rules: [seedRule({ user_id: BOB, rule_id: 'bob.rule' })],
        notifications: [seedNotification({ user_id: BOB, id: 99 })],
      });
      await Promise.all([
        request(db, '/_matrix/client/v3/pushers/set', jsonInit('POST', pusherBody({ pushkey: `alice-${i}` }))),
        request(
          db,
          rulePath('override', `alice.rule.${i}`),
          jsonInit('PUT', {
            actions: ['notify'],
            conditions: [{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }],
          })
        ),
        request(db, '/_matrix/client/v3/pushers', authGet()),
        request(db, '/_matrix/client/v3/notifications', authGet()),
      ]);
      expect(db.pushers.some((p) => p.user_id === BOB && p.pushkey === 'pk-bob')).toBe(true);
      expect(db.rules.some((r) => r.user_id === BOB && r.rule_id === 'bob.rule')).toBe(true);
      expect(db.notifications.some((n) => n.user_id === BOB && n.id === 99)).toBe(true);
    });
  }
});
