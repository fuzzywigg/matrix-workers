// Push Notifications API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#push-notifications
//
// This module handles:
// - Pusher registration and management
// - Push rules (override, content, room, sender, underride)
// - Notification listing
//
// Push notifications allow users to receive alerts on mobile devices
// even when the app is not running.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';

const app = new Hono<AppEnv>();

// ============================================
// Types
// ============================================

interface Pusher {
  pushkey: string;
  kind: string;
  app_id: string;
  app_display_name: string;
  device_display_name: string;
  profile_tag?: string;
  lang: string;
  data: {
    url?: string;
    format?: string;
    [key: string]: any;
  };
  append?: boolean;
}

/** Exported for unit tests. */
export interface PushRule {
  rule_id: string;
  default: boolean;
  enabled: boolean;
  conditions?: PushCondition[];
  actions: (string | { set_tweak: string; value?: any })[];
  pattern?: string;
}

/** Exported for unit tests. */
export interface PushCondition {
  kind: string;
  key?: string;
  pattern?: string;
  is?: string;
  value?: any;
}

// ============================================
// Default Push Rules
// ============================================

// Matrix spec defines default push rules that clients expect
const DEFAULT_OVERRIDE_RULES: PushRule[] = [
  {
    rule_id: '.m.rule.master',
    default: true,
    enabled: false,
    actions: ['dont_notify'],
  },
  {
    rule_id: '.m.rule.suppress_notices',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'content.msgtype', pattern: 'm.notice' },
    ],
    actions: ['dont_notify'],
  },
  {
    rule_id: '.m.rule.invite_for_me',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.member' },
      { kind: 'event_match', key: 'content.membership', pattern: 'invite' },
      { kind: 'event_match', key: 'state_key', pattern: '' }, // Will be replaced with user_id
    ],
    actions: ['notify', { set_tweak: 'sound', value: 'default' }],
  },
  {
    rule_id: '.m.rule.member_event',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.member' },
    ],
    actions: ['dont_notify'],
  },
  {
    rule_id: '.m.rule.is_user_mention',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_property_contains', key: 'content.m\\.mentions.user_ids', value: '' }, // user_id placeholder
    ],
    actions: ['notify', { set_tweak: 'sound', value: 'default' }, { set_tweak: 'highlight', value: true }],
  },
  {
    rule_id: '.m.rule.contains_display_name',
    default: true,
    enabled: true,
    conditions: [{ kind: 'contains_display_name' }],
    actions: ['notify', { set_tweak: 'sound', value: 'default' }, { set_tweak: 'highlight', value: true }],
  },
  {
    rule_id: '.m.rule.is_room_mention',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_property_is', key: 'content.m\\.mentions.room', value: true },
      { kind: 'sender_notification_permission', key: 'room' },
    ],
    actions: ['notify', { set_tweak: 'highlight', value: true }],
  },
  {
    rule_id: '.m.rule.tombstone',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.tombstone' },
      { kind: 'event_match', key: 'state_key', pattern: '' },
    ],
    actions: ['notify', { set_tweak: 'highlight', value: true }],
  },
  {
    rule_id: '.m.rule.room.server_acl',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.server_acl' },
      { kind: 'event_match', key: 'state_key', pattern: '' },
    ],
    actions: [],
  },
  {
    rule_id: '.m.rule.reaction',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.reaction' },
    ],
    actions: ['dont_notify'],
  },
];

const DEFAULT_CONTENT_RULES: PushRule[] = [
  {
    rule_id: '.m.rule.contains_user_name',
    default: true,
    enabled: true,
    pattern: '', // Will be replaced with localpart
    actions: ['notify', { set_tweak: 'sound', value: 'default' }, { set_tweak: 'highlight', value: true }],
  },
];

const DEFAULT_UNDERRIDE_RULES: PushRule[] = [
  {
    rule_id: '.m.rule.call',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.call.invite' },
    ],
    actions: ['notify', { set_tweak: 'sound', value: 'ring' }],
  },
  {
    rule_id: '.m.rule.encrypted_room_one_to_one',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'room_member_count', is: '2' },
      { kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' },
    ],
    actions: ['notify', { set_tweak: 'sound', value: 'default' }],
  },
  {
    rule_id: '.m.rule.room_one_to_one',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'room_member_count', is: '2' },
      { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
    ],
    actions: ['notify', { set_tweak: 'sound', value: 'default' }],
  },
  {
    rule_id: '.m.rule.message',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
    ],
    actions: ['notify'],
  },
  {
    rule_id: '.m.rule.encrypted',
    default: true,
    enabled: true,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' },
    ],
    actions: ['notify'],
  },
];

// ============================================
// Helper Functions
// ============================================

function getDefaultRulesForUser(userId: string): {
  override: PushRule[];
  content: PushRule[];
  room: PushRule[];
  sender: PushRule[];
  underride: PushRule[];
} {
  const localpart = userId.split(':')[0].substring(1); // Remove @ and domain

  // Clone and customize default rules
  const overrideRules = DEFAULT_OVERRIDE_RULES.map(rule => {
    const r = { ...rule, conditions: rule.conditions ? [...rule.conditions] : undefined };
    if (r.rule_id === '.m.rule.invite_for_me' && r.conditions) {
      r.conditions = r.conditions.map(c =>
        c.key === 'state_key' ? { ...c, pattern: userId } : { ...c }
      );
    }
    if (r.rule_id === '.m.rule.is_user_mention' && r.conditions) {
      r.conditions = r.conditions.map(c =>
        c.key?.includes('user_ids') ? { ...c, value: userId } : { ...c }
      );
    }
    return r;
  });

  const contentRules = DEFAULT_CONTENT_RULES.map(rule => ({
    ...rule,
    pattern: rule.rule_id === '.m.rule.contains_user_name' ? localpart : rule.pattern,
  }));

  return {
    override: overrideRules,
    content: contentRules,
    room: [],
    sender: [],
    underride: [...DEFAULT_UNDERRIDE_RULES],
  };
}

async function getUserPushRules(db: D1Database, userId: string): Promise<{
  global: {
    override: PushRule[];
    content: PushRule[];
    room: PushRule[];
    sender: PushRule[];
    underride: PushRule[];
  };
}> {
  // Get custom rules from database (using existing schema: conditions, actions columns)
  const customRules = await db.prepare(`
    SELECT kind, rule_id, conditions, actions, enabled FROM push_rules
    WHERE user_id = ?
    ORDER BY priority ASC
  `).bind(userId).all<{
    kind: string;
    rule_id: string;
    conditions: string | null;
    actions: string;
    enabled: number;
  }>();

  // Start with defaults
  const rules = getDefaultRulesForUser(userId);

  // Apply custom rules (override defaults or add new)
  for (const row of customRules.results) {
    let conditions: PushCondition[] | undefined;
    let actions: any[];

    try {
      conditions = row.conditions ? JSON.parse(row.conditions) : undefined;
    } catch {
      conditions = undefined;
    }

    try {
      actions = JSON.parse(row.actions);
    } catch {
      actions = [];
    }

    const ruleData: PushRule = {
      rule_id: row.rule_id,
      default: row.rule_id.startsWith('.m.rule.'),
      enabled: row.enabled === 1,
      actions,
      conditions,
    };

    const kindRules = rules[row.kind as keyof typeof rules];
    if (kindRules) {
      const existingIndex = kindRules.findIndex(r => r.rule_id === row.rule_id);
      if (existingIndex >= 0) {
        // Override existing rule
        kindRules[existingIndex] = { ...kindRules[existingIndex], ...ruleData };
      } else {
        // Add new rule
        kindRules.unshift(ruleData);
      }
    }
  }

  return { global: rules };
}

// ============================================
// Pusher Endpoints
// ============================================

// GET /_matrix/client/v3/pushers - Get all pushers for user
app.get('/_matrix/client/v3/pushers', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const pushers = await db.prepare(`
    SELECT pushkey, kind, app_id, app_display_name, device_display_name,
           profile_tag, lang, data
    FROM pushers
    WHERE user_id = ? AND enabled = 1
  `).bind(userId).all<{
    pushkey: string;
    kind: string;
    app_id: string;
    app_display_name: string;
    device_display_name: string;
    profile_tag: string | null;
    lang: string;
    data: string;
  }>();

  const pusherList = pushers.results.map(p => ({
    pushkey: p.pushkey,
    kind: p.kind,
    app_id: p.app_id,
    app_display_name: p.app_display_name,
    device_display_name: p.device_display_name,
    profile_tag: p.profile_tag || undefined,
    lang: p.lang,
    data: JSON.parse(p.data),
  }));

  return c.json({ pushers: pusherList });
});

// POST /_matrix/client/v3/pushers/set - Create or delete a pusher
app.post('/_matrix/client/v3/pushers/set', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  let body: Pusher & { kind?: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  console.log('[push] Pusher registration from', userId, ':', JSON.stringify(body));

  const { pushkey, kind, app_id, app_display_name, device_display_name, profile_tag, lang, data, append } = body;

  // Validate required fields
  if (!pushkey) {
    return Errors.missingParam('pushkey').toResponse();
  }

  // If kind is null, delete the pusher
  if (kind === null || kind === undefined) {
    await db.prepare(`
      DELETE FROM pushers WHERE user_id = ? AND pushkey = ? AND app_id = ?
    `).bind(userId, pushkey, app_id || '').run();

    return c.json({});
  }

  // Validate other required fields for creating/updating
  if (!app_id || !app_display_name || !device_display_name || !lang || !data) {
    return Errors.missingParam('app_id, app_display_name, device_display_name, lang, data').toResponse();
  }

  // If not appending, remove existing pushers with same pushkey
  if (!append) {
    await db.prepare(`
      DELETE FROM pushers WHERE user_id = ? AND pushkey = ?
    `).bind(userId, pushkey).run();
  }

  // Insert new pusher
  await db.prepare(`
    INSERT INTO pushers (
      user_id, pushkey, kind, app_id, app_display_name, device_display_name,
      profile_tag, lang, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, pushkey, app_id) DO UPDATE SET
      kind = excluded.kind,
      app_display_name = excluded.app_display_name,
      device_display_name = excluded.device_display_name,
      profile_tag = excluded.profile_tag,
      lang = excluded.lang,
      data = excluded.data,
      updated_at = strftime('%s', 'now') * 1000
  `).bind(
    userId,
    pushkey,
    kind,
    app_id,
    app_display_name,
    device_display_name,
    profile_tag || null,
    lang,
    JSON.stringify(data)
  ).run();

  return c.json({});
});

// ============================================
// Push Rules Endpoints
// ============================================

// GET /_matrix/client/v3/pushrules - Get all push rules
// Handle both with and without trailing slash
app.get('/_matrix/client/v3/pushrules', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rules = await getUserPushRules(db, userId);

  return c.json(rules);
});

app.get('/_matrix/client/v3/pushrules/', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rules = await getUserPushRules(db, userId);

  return c.json(rules);
});

// GET /_matrix/client/v3/pushrules/global - Get global push rules
app.get('/_matrix/client/v3/pushrules/global', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const rules = await getUserPushRules(db, userId);

  return c.json(rules.global);
});

// GET /_matrix/client/v3/pushrules/:scope/:kind/:ruleId - Get specific rule
app.get('/_matrix/client/v3/pushrules/:scope/:kind/:ruleId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const scope = c.req.param('scope');
  const kind = c.req.param('kind');
  const ruleId = decodeURIComponent(c.req.param('ruleId'));
  const db = c.env.DB;

  if (scope !== 'global') {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Only global scope is supported',
    }, 400);
  }

  const rules = await getUserPushRules(db, userId);
  const kindRules = rules.global[kind as keyof typeof rules.global];

  if (!kindRules) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: `Unknown rule kind: ${kind}`,
    }, 400);
  }

  const rule = kindRules.find(r => r.rule_id === ruleId);
  if (!rule) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Push rule not found',
    }, 404);
  }

  return c.json(rule);
});

// PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId - Create/update rule
app.put('/_matrix/client/v3/pushrules/:scope/:kind/:ruleId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const scope = c.req.param('scope');
  const kind = c.req.param('kind');
  const ruleId = decodeURIComponent(c.req.param('ruleId'));
  const db = c.env.DB;

  if (scope !== 'global') {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Only global scope is supported',
    }, 400);
  }

  // Can't modify default rules (they start with .)
  if (ruleId.startsWith('.m.rule.')) {
    return c.json({
      errcode: 'M_CANNOT_OVERWRITE_DEFAULT',
      error: 'Cannot overwrite default rules',
    }, 400);
  }

  let body: Partial<PushRule>;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { actions, conditions, pattern } = body;

  if (!actions) {
    return Errors.missingParam('actions').toResponse();
  }

  // Content rules require pattern
  if (kind === 'content' && !pattern) {
    return Errors.missingParam('pattern').toResponse();
  }

  // Build rule data
  const ruleData: PushRule = {
    rule_id: ruleId,
    default: false,
    enabled: true,
    actions,
  };

  if (conditions) {
    ruleData.conditions = conditions;
  }

  if (pattern) {
    ruleData.pattern = pattern;
  }

  // Get priority from query params
  const before = c.req.query('before');
  const after = c.req.query('after');
  let priority = 0;

  if (before || after) {
    priority = Date.now();
  }

  await db.prepare(`
    INSERT INTO push_rules (user_id, kind, rule_id, conditions, actions, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (user_id, kind, rule_id) DO UPDATE SET
      conditions = excluded.conditions,
      actions = excluded.actions,
      priority = excluded.priority
  `).bind(
    userId,
    kind,
    ruleId,
    conditions ? JSON.stringify(conditions) : null,
    JSON.stringify(actions),
    priority
  ).run();

  return c.json({});
});

// DELETE /_matrix/client/v3/pushrules/:scope/:kind/:ruleId - Delete rule
app.delete('/_matrix/client/v3/pushrules/:scope/:kind/:ruleId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const scope = c.req.param('scope');
  const kind = c.req.param('kind');
  const ruleId = decodeURIComponent(c.req.param('ruleId'));
  const db = c.env.DB;

  if (scope !== 'global') {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Only global scope is supported',
    }, 400);
  }

  // Can't delete default rules
  if (ruleId.startsWith('.m.rule.')) {
    return c.json({
      errcode: 'M_CANNOT_DELETE_DEFAULT',
      error: 'Cannot delete default rules',
    }, 400);
  }

  const result = await db.prepare(`
    DELETE FROM push_rules WHERE user_id = ? AND kind = ? AND rule_id = ?
  `).bind(userId, kind, ruleId).run();

  if (result.meta.changes === 0) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Push rule not found',
    }, 404);
  }

  return c.json({});
});

// PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId/enabled - Enable/disable rule
app.put('/_matrix/client/v3/pushrules/:scope/:kind/:ruleId/enabled', requireAuth(), async (c) => {
  const userId = c.get('userId');
  // Note: scope is always 'global' in current implementation
  void c.req.param('scope');
  const kind = c.req.param('kind');
  const ruleId = decodeURIComponent(c.req.param('ruleId'));
  const db = c.env.DB;

  let body: { enabled: boolean };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (typeof body.enabled !== 'boolean') {
    return Errors.missingParam('enabled').toResponse();
  }

  // For default rules, we need to create an override entry
  if (ruleId.startsWith('.m.rule.')) {
    // Get the default rule
    const rules = getDefaultRulesForUser(userId);
    const kindRules = rules[kind as keyof typeof rules];
    const defaultRule = kindRules?.find(r => r.rule_id === ruleId);

    if (!defaultRule) {
      return c.json({
        errcode: 'M_NOT_FOUND',
        error: 'Push rule not found',
      }, 404);
    }

    // Store override with enabled status
    await db.prepare(`
      INSERT INTO push_rules (user_id, kind, rule_id, conditions, actions, enabled, priority)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT (user_id, kind, rule_id) DO UPDATE SET
        enabled = excluded.enabled
    `).bind(
      userId,
      kind,
      ruleId,
      defaultRule.conditions ? JSON.stringify(defaultRule.conditions) : null,
      JSON.stringify(defaultRule.actions),
      body.enabled ? 1 : 0
    ).run();
  } else {
    // Update custom rule
    await db.prepare(`
      UPDATE push_rules SET enabled = ? WHERE user_id = ? AND kind = ? AND rule_id = ?
    `).bind(body.enabled ? 1 : 0, userId, kind, ruleId).run();
  }

  return c.json({});
});

// PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId/actions - Set rule actions
app.put('/_matrix/client/v3/pushrules/:scope/:kind/:ruleId/actions', requireAuth(), async (c) => {
  const userId = c.get('userId');
  // Note: scope is always 'global' in current implementation
  void c.req.param('scope');
  const kind = c.req.param('kind');
  const ruleId = decodeURIComponent(c.req.param('ruleId'));
  const db = c.env.DB;

  let body: { actions: any[] };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!Array.isArray(body.actions)) {
    return Errors.missingParam('actions').toResponse();
  }

  // Get current rule (default or custom)
  const customRule = await db.prepare(`
    SELECT conditions, actions FROM push_rules WHERE user_id = ? AND kind = ? AND rule_id = ?
  `).bind(userId, kind, ruleId).first<{ conditions: string | null; actions: string }>();

  let ruleConditions: PushCondition[] | undefined;
  let ruleActions: any[] = body.actions;

  if (customRule) {
    try {
      ruleConditions = customRule.conditions ? JSON.parse(customRule.conditions) : undefined;
    } catch {
      ruleConditions = undefined;
    }
  } else if (ruleId.startsWith('.m.rule.')) {
    // Get default rule
    const rules = getDefaultRulesForUser(userId);
    const kindRules = rules[kind as keyof typeof rules];
    const defaultRule = kindRules?.find(r => r.rule_id === ruleId);

    if (!defaultRule) {
      return c.json({
        errcode: 'M_NOT_FOUND',
        error: 'Push rule not found',
      }, 404);
    }

    ruleConditions = defaultRule.conditions;
  } else {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Push rule not found',
    }, 404);
  }

  await db.prepare(`
    INSERT INTO push_rules (user_id, kind, rule_id, conditions, actions, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT (user_id, kind, rule_id) DO UPDATE SET
      actions = excluded.actions
  `).bind(
    userId,
    kind,
    ruleId,
    ruleConditions ? JSON.stringify(ruleConditions) : null,
    JSON.stringify(ruleActions)
  ).run();

  return c.json({});
});

// ============================================
// Notifications Endpoint
// ============================================

// GET /_matrix/client/v3/notifications - Get notification history
app.get('/_matrix/client/v3/notifications', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const from = c.req.query('from');
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const only = c.req.query('only'); // 'highlight' to only show highlights
  const db = c.env.DB;

  let sincePosition = 0;
  if (from) {
    sincePosition = parseInt(from, 10) || 0;
  }

  // Get notifications from queue
  let query = `
    SELECT nq.id, nq.room_id, nq.event_id, nq.notification_type, nq.actions, nq.read, nq.created_at,
           e.event_type, e.sender, e.content
    FROM notification_queue nq
    LEFT JOIN events e ON nq.event_id = e.event_id
    WHERE nq.user_id = ?
  `;

  const params: any[] = [userId];

  if (sincePosition > 0) {
    query += ` AND nq.id > ?`;
    params.push(sincePosition);
  }

  if (only === 'highlight') {
    query += ` AND nq.notification_type = 'highlight'`;
  }

  query += ` ORDER BY nq.created_at DESC LIMIT ?`;
  params.push(Math.min(limit, 100));

  const notifications = await db.prepare(query).bind(...params).all<{
    id: number;
    room_id: string;
    event_id: string;
    notification_type: string;
    actions: string;
    read: number;
    created_at: number;
    event_type: string;
    sender: string;
    content: string;
  }>();

  const notificationList = notifications.results.map(n => {
    let content = {};
    try {
      content = JSON.parse(n.content || '{}');
    } catch {}

    let actions: any[] = [];
    try {
      actions = JSON.parse(n.actions || '[]');
    } catch {}

    return {
      room_id: n.room_id,
      event: {
        event_id: n.event_id,
        type: n.event_type,
        sender: n.sender,
        content,
        room_id: n.room_id,
        origin_server_ts: n.created_at,
      },
      read: n.read === 1,
      ts: n.created_at,
      actions,
      profile_tag: undefined,
    };
  });

  // Calculate next_token
  let nextToken: string | undefined;
  if (notifications.results.length > 0) {
    const lastId = notifications.results[notifications.results.length - 1].id;
    nextToken = String(lastId);
  }

  return c.json({
    notifications: notificationList,
    next_token: nextToken,
  });
});

// ============================================
// Internal: Queue notification for event
// ============================================

export async function queueNotification(
  db: D1Database,
  userId: string,
  roomId: string,
  eventId: string,
  notificationType: string,
  actions: any[]
): Promise<void> {
  await db.prepare(`
    INSERT INTO notification_queue (user_id, room_id, event_id, notification_type, actions)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, roomId, eventId, notificationType, JSON.stringify(actions)).run();
}

// ============================================
// Internal: Evaluate push rules for event
// ============================================

export async function evaluatePushRules(
  db: D1Database,
  userId: string,
  event: {
    type: string;
    content: any;
    sender: string;
    room_id: string;
    state_key?: string;
  },
  roomMemberCount: number,
  displayName?: string
): Promise<{ notify: boolean; actions: any[]; highlight: boolean }> {
  const rules = await getUserPushRules(db, userId);

  // Combine all rules in priority order
  const allRules = [
    ...rules.global.override,
    ...rules.global.content,
    ...rules.global.room,
    ...rules.global.sender,
    ...rules.global.underride,
  ].filter(r => r.enabled);

  for (const rule of allRules) {
    if (matchesRule(rule, event, userId, roomMemberCount, displayName)) {
      const notify = !rule.actions.includes('dont_notify') && rule.actions.some(a => a === 'notify');
      const highlight = rule.actions.some(a =>
        typeof a === 'object' && a.set_tweak === 'highlight' && a.value !== false
      );

      return { notify, actions: rule.actions, highlight };
    }
  }

  return { notify: false, actions: [], highlight: false };
}

/** Exported for unit tests. */
export function matchesRule(
  rule: PushRule,
  event: any,
  userId: string,
  roomMemberCount: number,
  displayName?: string
): boolean {
  // Content rules check pattern against body
  if (rule.pattern) {
    const body = event.content?.body;
    if (!body) return false;

    // Convert glob pattern to regex
    const regex = new RegExp(
      rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'),
      'i'
    );
    return regex.test(body);
  }

  // Check all conditions
  if (rule.conditions) {
    return rule.conditions.every(condition => matchesCondition(condition, event, userId, roomMemberCount, displayName));
  }

  return true;
}

/** Exported for unit tests. */
export function matchesCondition(
  condition: PushCondition,
  event: any,
  userId: string,
  roomMemberCount: number,
  displayName?: string
): boolean {
  switch (condition.kind) {
    case 'event_match': {
      if (!condition.key || !condition.pattern) return false;
      const value = getNestedValue(event, condition.key);
      if (value === undefined) return false;

      // Handle user_id placeholder
      const pattern = condition.pattern === '' ? userId : condition.pattern;
      const regex = new RegExp(
        pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'),
        'i'
      );
      return regex.test(String(value));
    }

    case 'room_member_count': {
      if (!condition.is) return false;
      const match = condition.is.match(/^(==|<|>|<=|>=)?(\d+)$/);
      if (!match) return false;

      const op = match[1] || '==';
      const count = parseInt(match[2], 10);

      switch (op) {
        case '==': return roomMemberCount === count;
        case '<': return roomMemberCount < count;
        case '>': return roomMemberCount > count;
        case '<=': return roomMemberCount <= count;
        case '>=': return roomMemberCount >= count;
        default: return false;
      }
    }

    case 'contains_display_name': {
      if (!displayName) return false;
      const body = event.content?.body;
      if (!body) return false;
      return body.toLowerCase().includes(displayName.toLowerCase());
    }

    case 'sender_notification_permission': {
      // Simplified: assume sender has permission
      return true;
    }

    case 'event_property_is': {
      if (!condition.key) return false;
      const value = getNestedValue(event, condition.key.replace(/\\\./g, '.'));
      return value === condition.value;
    }

    case 'event_property_contains': {
      if (!condition.key) return false;
      const value = getNestedValue(event, condition.key.replace(/\\\./g, '.'));
      if (!Array.isArray(value)) return false;
      return value.includes(condition.value);
    }

    default:
      return true;
  }
}

/** Exported for unit tests. */
export function getNestedValue(obj: any, path: string): any {
  const keys = path.split('.');
  let value = obj;

  for (const key of keys) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }

  return value;
}

// ============================================
// Push Notification Delivery
// ============================================

interface PusherData {
  url: string;
  format?: string;
  default_payload?: any;
}

// Generate a short correlation ID for tracking push -> NSE flow
function generatePushCorrelationId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// Send push notification to a user's registered pushers
export async function sendPushNotification(
  db: D1Database,
  userId: string,
  event: {
    event_id: string;
    room_id: string;
    type: string;
    sender: string;
    content: any;
    origin_server_ts: number;
    sender_display_name?: string;
    room_name?: string;
  },
  counts: { unread: number; missed_calls?: number },
  env?: import('../types').Env  // Optional env for direct APNs delivery
): Promise<void> {
  // Generate correlation ID for tracking push -> NSE flow
  const correlationId = generatePushCorrelationId();
  const pushTimestamp = new Date().toISOString();

  // Log push initiation with correlation ID
  // This can be correlated with NSE/context requests in sliding-sync.ts and rooms.ts
  console.log('[push] PUSH_INITIATED:', {
    correlationId,
    userId,
    eventId: event.event_id,
    roomId: event.room_id,
    eventType: event.type,
    sender: event.sender,
    senderDisplayName: event.sender_display_name,
    roomName: event.room_name,
    timestamp: pushTimestamp,
  });

  // Get user's pushers
  const pushers = await db.prepare(`
    SELECT pushkey, kind, app_id, data FROM pushers WHERE user_id = ?
  `).bind(userId).all<{ pushkey: string; kind: string; app_id: string; data: string }>();

  if (pushers.results.length === 0) {
    console.log('[push] PUSH_NO_PUSHERS:', { correlationId, userId });
    return; // No pushers registered
  }

  console.log('[push] PUSH_PUSHERS_FOUND:', {
    correlationId,
    userId,
    pusherCount: pushers.results.length,
    pusherAppIds: pushers.results.map(p => p.app_id),
  });

  // Check if direct APNs is configured
  const useDirectAPNs = env?.APNS_KEY_ID && env?.APNS_TEAM_ID && env?.APNS_PRIVATE_KEY;

  for (const pusher of pushers.results) {
    if (pusher.kind !== 'http') {
      continue; // Only HTTP pushers supported
    }

    let pusherData: PusherData;
    try {
      pusherData = JSON.parse(pusher.data);
    } catch {
      console.error('[push] Failed to parse pusher data for', userId);
      continue;
    }

    // Prepare sender and room display names
    const senderDisplayName = event.sender_display_name || event.sender.split(':')[0].replace('@', '');
    const roomDisplayName = event.room_name || 'Chat';

    // Check if this is an iOS pusher (has default_payload.aps)
    const isIOSPusher = pusherData.default_payload?.aps !== undefined;

    // Try direct APNs delivery for iOS pushers if configured
    if (useDirectAPNs && isIOSPusher && env) {
      const success = await sendDirectAPNs(env, pusher, pusherData, event, senderDisplayName, roomDisplayName, counts);
      if (success) {
        // Update pusher success
        await db.prepare(`
          UPDATE pushers SET last_success = ?, failure_count = 0
          WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `).bind(Date.now(), userId, pusher.pushkey, pusher.app_id).run();
        continue; // Successfully sent via direct APNs, skip Sygnal
      }
      // If direct APNs failed, fall through to Sygnal
      console.log('[push] Direct APNs failed, falling back to Sygnal');
    }

    // Fall back to Sygnal (or use it directly if not iOS/no direct APNs)
    if (!pusherData.url) {
      console.error('[push] Pusher has no URL for', userId);
      continue;
    }

    // Build notification payload per Matrix Push Gateway spec
    // https://spec.matrix.org/v1.12/push-gateway-api/

    // Deep clone default_payload and populate APNs alert for proper iOS notification display
    const deviceData = JSON.parse(JSON.stringify(pusherData.default_payload || {}));

    // Set direct alert body instead of loc-key/loc-args (Element X doesn't have our loc-keys)
    // This is the fallback text shown if NSE can't process the notification
    if (deviceData.aps) {
      if (event.type === 'm.room.encrypted') {
        // For encrypted messages, show sender and room (can't show content)
        deviceData.aps.alert = {
          title: senderDisplayName,
          body: roomDisplayName,
        };
      } else {
        // For unencrypted messages, show sender and message preview
        const messageBody = event.content?.body || 'New message';
        deviceData.aps.alert = {
          title: senderDisplayName,
          subtitle: roomDisplayName,
          body: messageBody,
        };
      }
      // Keep mutable-content so NSE can still process and override with rich content
      deviceData.aps['mutable-content'] = 1;
    }

    // NSE needs these fields to fetch event content
    // Add them to default_payload so Sygnal merges them into APNs payload
    deviceData.event_id = event.event_id;
    deviceData.room_id = event.room_id;
    deviceData.sender = event.sender;
    deviceData.unread_count = counts.unread;

    // Per Matrix Push Gateway spec, devices[].data should be the pusher data minus URL
    // Sygnal looks for default_payload nested inside data, not at the root
    const pusherDataForGateway: any = {
      format: pusherData.format,
      default_payload: deviceData,
    };

    const notification: any = {
      notification: {
        event_id: event.event_id,
        room_id: event.room_id,
        type: event.type,
        sender: event.sender,
        sender_display_name: senderDisplayName,
        room_name: roomDisplayName,
        prio: 'high',
        counts: counts,
        devices: [{
          app_id: pusher.app_id,
          pushkey: pusher.pushkey,
          pushkey_ts: Date.now(),
          data: pusherDataForGateway,
        }],
      },
    };

    // Include content for non-event_id_only format
    if (pusherData.format !== 'event_id_only') {
      notification.notification.content = event.content;
    }

    try {
      console.log('[push] PUSH_SENDING:', {
        correlationId,
        userId,
        eventId: event.event_id,
        gatewayUrl: pusherData.url,
        appId: pusher.app_id,
      });
      console.log('[push] Notification payload:', JSON.stringify(notification, null, 2));

      const response = await fetch(pusherData.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(notification),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[push] PUSH_GATEWAY_ERROR:', {
          correlationId,
          userId,
          eventId: event.event_id,
          status: response.status,
          error: text,
        });

        // Update pusher failure count
        await db.prepare(`
          UPDATE pushers SET last_failure = ?, failure_count = failure_count + 1
          WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `).bind(Date.now(), userId, pusher.pushkey, pusher.app_id).run();
      } else {
        // Parse gateway response (Sygnal returns rejected device tokens)
        let gatewayResponse: any = {};
        try {
          gatewayResponse = await response.json();
        } catch {
          gatewayResponse = {};
        }

        console.log('[push] PUSH_SENT_SUCCESS:', {
          correlationId,
          userId,
          eventId: event.event_id,
          roomId: event.room_id,
          appId: pusher.app_id,
          gatewayResponse,
          timestamp: new Date().toISOString(),
          // IMPORTANT: NSE should make a request within ~30 seconds of this timestamp
          // Look for [sliding-sync] POTENTIAL NSE REQUEST or [rooms/context] Request
          // with matching roomId and eventId shortly after this log entry
        });

        // Update pusher success
        await db.prepare(`
          UPDATE pushers SET last_success = ?, failure_count = 0
          WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `).bind(Date.now(), userId, pusher.pushkey, pusher.app_id).run();
      }
    } catch (error) {
      console.error('[push] PUSH_SEND_ERROR:', {
        correlationId,
        userId,
        eventId: event.event_id,
        error: String(error),
      });

      // Update pusher failure count
      await db.prepare(`
        UPDATE pushers SET last_failure = ?, failure_count = failure_count + 1
        WHERE user_id = ? AND pushkey = ? AND app_id = ?
      `).bind(Date.now(), userId, pusher.pushkey, pusher.app_id).run();
    }
  }
}

// Send push notification directly to APNs via Push Durable Object
async function sendDirectAPNs(
  env: import('../types').Env,
  pusher: { pushkey: string; app_id: string },
  _pusherData: PusherData,
  event: {
    event_id: string;
    room_id: string;
    type: string;
    sender: string;
    content: any;
  },
  senderDisplayName: string,
  roomDisplayName: string,
  counts: { unread: number; missed_calls?: number }
): Promise<boolean> {
  try {
    // Get Push Durable Object
    const pushDO = env.PUSH;
    const doId = pushDO.idFromName('apns'); // Single DO instance for APNs
    const stub = pushDO.get(doId);

    // Build APNs payload with direct alert text (bypassing Sygnal's loc-key handling)
    const aps: any = {
      'mutable-content': 1,  // Allow NSE to modify
      sound: 'default',
    };

    if (event.type === 'm.room.encrypted') {
      // For encrypted messages, show sender and room (can't show content)
      aps.alert = {
        title: senderDisplayName,
        body: roomDisplayName,
      };
    } else {
      // For unencrypted messages, show sender and message preview
      const messageBody = event.content?.body || 'New message';
      aps.alert = {
        title: senderDisplayName,
        subtitle: roomDisplayName,
        body: messageBody,
      };
    }

    // Set badge to unread count
    if (counts.unread > 0) {
      aps.badge = counts.unread;
    }

    // Build full APNs payload with Matrix event data for NSE
    const apnsPayload = {
      aps,
      // Matrix-specific fields for NSE to fetch/decrypt the event
      room_id: event.room_id,
      event_id: event.event_id,
      sender: event.sender,
      unread_count: counts.unread,
    };

    // Determine bundle ID from app_id
    // Element X iOS uses app_id like "io.element.elementx.ios" or similar
    const topic = pusher.app_id.replace(/\.ios$/, '').replace(/\.prod$/, '').replace(/\.dev$/, '');

    console.log('[push] Sending direct APNs via Push DO:', {
      topic,
      pushkey: pusher.pushkey.substring(0, 16) + '...',
      alert: aps.alert,
    });

    // Send via Push DO
    const response = await stub.fetch(new Request('https://push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pushkey: pusher.pushkey,
        topic,
        payload: apnsPayload,
        priority: 10,
      }),
    }));

    const result = await response.json() as { success: boolean; apnsId?: string; error?: string };

    if (result.success) {
      console.log('[push] Direct APNs success, apns-id:', result.apnsId);
      return true;
    } else {
      console.error('[push] Direct APNs failed:', result.error);
      return false;
    }
  } catch (error) {
    console.error('[push] Direct APNs error:', error);
    return false;
  }
}

// Notify all room members about a new event (called when messages are sent)
export async function notifyRoomMembersOfMessage(
  db: D1Database,
  env: import('../types').Env,
  event: {
    event_id: string;
    room_id: string;
    type: string;
    sender: string;
    content: any;
    origin_server_ts: number;
  }
): Promise<void> {
  // Get all joined members except the sender
  const members = await db.prepare(`
    SELECT user_id FROM room_memberships
    WHERE room_id = ? AND membership = 'join' AND user_id != ?
  `).bind(event.room_id, event.sender).all<{ user_id: string }>();

  // Get room member count for push rule evaluation
  const memberCountResult = await db.prepare(`
    SELECT COUNT(*) as count FROM room_memberships
    WHERE room_id = ? AND membership = 'join'
  `).bind(event.room_id).first<{ count: number }>();
  const roomMemberCount = memberCountResult?.count || 0;

  // Get sender's display name from room membership
  const senderMembership = await db.prepare(`
    SELECT display_name FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `).bind(event.room_id, event.sender).first<{ display_name: string | null }>();
  const senderDisplayName = senderMembership?.display_name || event.sender.split(':')[0].replace('@', '');

  // Get room name from state
  const roomNameEvent = await db.prepare(`
    SELECT content FROM events
    WHERE room_id = ? AND event_type = 'm.room.name' AND state_key = ''
    ORDER BY origin_server_ts DESC LIMIT 1
  `).bind(event.room_id).first<{ content: string }>();
  let roomName: string | undefined;
  if (roomNameEvent) {
    try {
      const content = JSON.parse(roomNameEvent.content);
      roomName = content.name;
    } catch {}
  }

  // For DM rooms without explicit name, use the sender's display name as room name
  if (!roomName && roomMemberCount === 2) {
    roomName = senderDisplayName;
  }

  // Process each member in parallel
  const notifications = members.results.map(async (member) => {
    try {
      // Evaluate push rules for this user
      const pushResult = await evaluatePushRules(
        db,
        member.user_id,
        event,
        roomMemberCount
      );

      if (!pushResult.notify) {
        return; // User's push rules say don't notify
      }

      // Get unread count for this user in this room
      const unreadResult = await db.prepare(`
        SELECT COUNT(*) as count FROM events e
        WHERE e.room_id = ?
          AND e.stream_ordering > COALESCE(
            (SELECT CAST(json_extract(content, '$.event_id') AS TEXT) FROM account_data
             WHERE user_id = ? AND room_id = ? AND event_type = 'm.fully_read'),
            ''
          )
          AND e.sender != ?
          AND e.event_type IN ('m.room.message', 'm.room.encrypted')
      `).bind(event.room_id, member.user_id, event.room_id, member.user_id).first<{ count: number }>();

      const unreadCount = unreadResult?.count || 1;

      // Send push notification with sender display name and room name
      await sendPushNotification(db, member.user_id, {
        ...event,
        sender_display_name: senderDisplayName,
        room_name: roomName,
      }, { unread: unreadCount }, env);

      // Queue notification for history
      await db.prepare(`
        INSERT INTO notification_queue (user_id, room_id, event_id, notification_type, actions)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        member.user_id,
        event.room_id,
        event.event_id,
        pushResult.highlight ? 'highlight' : 'notify',
        JSON.stringify(pushResult.actions)
      ).run();

    } catch (error) {
      console.error('[push] Failed to notify user', member.user_id, ':', error);
    }
  });

  await Promise.all(notifications);
}

export default app;
