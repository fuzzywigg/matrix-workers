// Search API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#searching
//
// Provides full-text search for room messages

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';

const app = new Hono<AppEnv>();

// ============================================
// Types (exported for unit tests)
// ============================================

export interface SearchFilter {
  rooms?: string[];
  not_rooms?: string[];
  senders?: string[];
  not_senders?: string[];
  types?: string[];
  not_types?: string[];
}

export interface SearchEventContext {
  before_limit?: number;
  after_limit?: number;
  include_profile?: boolean;
}

export interface SearchRoomEventsRequest {
  search_term: string;
  keys?: string[];
  filter?: SearchFilter;
  order_by?: 'recent' | 'rank';
  event_context?: SearchEventContext;
  include_state?: boolean;
  groupings?: {
    group_by: Array<{ key: string }>;
  };
}

export interface SearchRequest {
  search_categories: {
    room_events?: SearchRoomEventsRequest;
  };
}

export interface SearchResult {
  event_id: string;
  rank: number;
  result: {
    event_id: string;
    type: string;
    room_id: string;
    sender: string;
    origin_server_ts: number;
    content: Record<string, any>;
  };
  context?: {
    events_before: any[];
    events_after: any[];
    profile_info?: Record<string, { displayname?: string; avatar_url?: string }>;
    start?: string;
    end?: string;
  };
}

export interface SearchEventRow {
  event_id: string;
  event_type: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  rank: number;
}

export interface ContextEventRow {
  event_id: string;
  event_type: string;
  sender: string;
  origin_server_ts: number;
  content: string;
}

export interface GroupBucket {
  results: string[];
  order: number;
  next_batch?: string;
}

/** Page size for `/search` results (plus one for hasMore). Exported for unit tests. */
export const SEARCH_PAGE_SIZE = 50;

/** Default context window sizes when `event_context` is requested. */
export const DEFAULT_CONTEXT_BEFORE = 5;
export const DEFAULT_CONTEXT_AFTER = 5;

// ============================================
// Helper Functions (exported for unit tests)
// ============================================

/** Empty `room_events` category payload used for early exits. */
export function emptyRoomEventsResponse() {
  return {
    search_categories: {
      room_events: {
        results: [] as SearchResult[],
        count: 0,
        highlights: [] as string[],
      },
    },
  };
}

/** True when the search term is missing or whitespace-only. */
export function isBlankSearchTerm(searchTerm: string | null | undefined): boolean {
  return !searchTerm || searchTerm.trim().length === 0;
}

/**
 * Escape FTS5 special characters in a search term.
 * Replaces `' " * ( )` with spaces and trims.
 */
export function escapeFtsSearchTerm(searchTerm: string): string {
  return searchTerm.replace(/['"*()]/g, ' ').trim();
}

/**
 * Parse `next_batch` query into an offset (default 0).
 * Mirrors prior route behavior: truthy values go through parseInt (NaN possible).
 */
export function parseSearchOffset(nextBatch: string | null | undefined): number {
  if (!nextBatch) {
    return 0;
  }
  try {
    return parseInt(nextBatch, 10);
  } catch {
    return 0;
  }
}

/**
 * Intersect the caller's joined/left rooms with optional `rooms` / `not_rooms` filters.
 * Order of `userRoomIds` is preserved.
 */
export function applyRoomFilters(
  userRoomIds: Iterable<string>,
  filter: SearchFilter = {}
): string[] {
  let searchRoomIds = Array.from(userRoomIds);

  if (filter.rooms && filter.rooms.length > 0) {
    const allow = new Set(filter.rooms);
    searchRoomIds = searchRoomIds.filter((r) => allow.has(r));
  }

  if (filter.not_rooms && filter.not_rooms.length > 0) {
    const deny = new Set(filter.not_rooms);
    searchRoomIds = searchRoomIds.filter((r) => !deny.has(r));
  }

  return searchRoomIds;
}

/** SQL `ORDER BY` fragment for search results. */
export function buildOrderByClause(orderBy: 'recent' | 'rank' | string | undefined): string {
  if (orderBy === 'rank') {
    // BM25 returns negative values, lower = better
    return ' ORDER BY rank ASC';
  }
  return ' ORDER BY e.origin_server_ts DESC';
}

/**
 * Append an `IN` / `NOT IN` filter clause and bind values.
 * No-op when `values` is empty/undefined.
 */
export function appendInFilter(
  query: string,
  params: unknown[],
  column: string,
  values: string[] | undefined,
  negate = false
): string {
  if (!values || values.length === 0) {
    return query;
  }
  const placeholders = values.map(() => '?').join(',');
  const op = negate ? 'NOT IN' : 'IN';
  params.push(...values);
  return `${query} AND ${column} ${op} (${placeholders})`;
}

/** Append sender + type filters from a SearchFilter onto a base query. */
export function appendSenderTypeFilters(
  query: string,
  params: unknown[],
  filter: SearchFilter
): string {
  let q = query;
  q = appendInFilter(q, params, 'e.sender', filter.senders, false);
  q = appendInFilter(q, params, 'e.sender', filter.not_senders, true);
  q = appendInFilter(q, params, 'e.event_type', filter.types, false);
  q = appendInFilter(q, params, 'e.event_type', filter.not_types, true);
  return q;
}

/** Safe JSON.parse for event content; returns `{}` on failure (prior route behavior). */
export function parseEventContent(content: string | null | undefined): Record<string, any> {
  try {
    return JSON.parse(content as string);
  } catch {
    return {};
  }
}

/**
 * Parse context event content — prior behavior used bare JSON.parse (throws on bad JSON).
 * Exported so tests can document the route path vs the safe helper.
 */
export function parseContextEventContent(content: string): Record<string, any> {
  return JSON.parse(content);
}

/** Absolute BM25 rank (product stores Math.abs(rank || 0)). */
export function absoluteRank(rank: number | null | undefined): number {
  return Math.abs(rank || 0);
}

/** Build a SearchResult from a joined FTS/events row (no context). */
export function buildSearchResultFromRow(event: SearchEventRow): SearchResult {
  return {
    event_id: event.event_id,
    rank: absoluteRank(event.rank),
    result: {
      event_id: event.event_id,
      type: event.event_type,
      room_id: event.room_id,
      sender: event.sender,
      origin_server_ts: event.origin_server_ts,
      content: parseEventContent(event.content),
    },
  };
}

/** Map a context row into a Matrix-ish event object for the response. */
export function formatContextEvent(row: ContextEventRow, roomId: string): Record<string, any> {
  return {
    event_id: row.event_id,
    type: row.event_type,
    sender: row.sender,
    origin_server_ts: row.origin_server_ts,
    content: parseContextEventContent(row.content),
    room_id: roomId,
  };
}

/** Resolve before/after context limits with defaults. */
export function resolveContextLimits(eventContext: SearchEventContext): {
  beforeLimit: number;
  afterLimit: number;
} {
  return {
    beforeLimit: eventContext.before_limit ?? DEFAULT_CONTEXT_BEFORE,
    afterLimit: eventContext.after_limit ?? DEFAULT_CONTEXT_AFTER,
  };
}

/** Collect unique sender IDs from a hit and its context rows. */
export function collectContextSenders(
  hitSender: string,
  before: Array<{ sender: string }>,
  after: Array<{ sender: string }>
): string[] {
  const senders = new Set<string>();
  senders.add(hitSender);
  before.forEach((e) => senders.add(e.sender));
  after.forEach((e) => senders.add(e.sender));
  return [...senders];
}

/** Map a users-table profile row into search `profile_info` shape. */
export function mapUserProfile(profile: {
  display_name: string | null;
  avatar_url: string | null;
}): { displayname?: string; avatar_url?: string } {
  return {
    displayname: profile.display_name || undefined,
    avatar_url: profile.avatar_url || undefined,
  };
}

/** Pagination token when more results exist beyond the current page. */
export function nextBatchToken(
  offset: number,
  pageSize: number,
  hasMore: boolean
): string | undefined {
  if (!hasMore) {
    return undefined;
  }
  return String(offset + pageSize);
}

/** Slice `limit+1` query rows into page + hasMore. */
export function paginateSearchRows<T>(rows: T[], pageSize: number = SEARCH_PAGE_SIZE): {
  page: T[];
  hasMore: boolean;
} {
  const hasMore = rows.length > pageSize;
  return { page: rows.slice(0, pageSize), hasMore };
}

/**
 * Build Matrix search groupings for `room_id` / `sender` keys.
 * Unknown keys are ignored. Returns `undefined` when no groups were produced.
 */
export function buildSearchGroupings(
  formattedResults: SearchResult[],
  groupBy: Array<{ key: string }> | undefined
): Record<string, Record<string, GroupBucket>> | undefined {
  if (!groupBy || groupBy.length === 0) {
    return undefined;
  }

  const groups: Record<string, Record<string, GroupBucket>> = {};

  for (const entry of groupBy) {
    if (entry.key === 'room_id') {
      const roomGroups: Record<string, GroupBucket> = {};
      for (const result of formattedResults) {
        const roomId = result.result.room_id;
        if (!roomGroups[roomId]) {
          roomGroups[roomId] = { results: [], order: 0 };
        }
        roomGroups[roomId].results.push(result.event_id);
      }
      groups.room_id = roomGroups;
    } else if (entry.key === 'sender') {
      const senderGroups: Record<string, GroupBucket> = {};
      for (const result of formattedResults) {
        const sender = result.result.sender;
        if (!senderGroups[sender]) {
          senderGroups[sender] = { results: [], order: 0 };
        }
        senderGroups[sender].results.push(result.event_id);
      }
      groups.sender = senderGroups;
    }
  }

  if (Object.keys(groups).length === 0) {
    return undefined;
  }
  return groups;
}

/** Unique room IDs appearing in formatted results (insertion order). */
export function uniqueResultRoomIds(formattedResults: SearchResult[]): string[] {
  const roomIds = new Set<string>();
  for (const r of formattedResults) {
    roomIds.add(r.result.room_id);
  }
  return [...roomIds];
}

/** Map a room_state join row into the include_state response shape. */
export function formatStateEvent(
  row: {
    event_type: string;
    state_key: string;
    sender: string;
    content: string;
    origin_server_ts: number;
  },
  roomId: string
): Record<string, any> {
  return {
    type: row.event_type,
    state_key: row.state_key,
    sender: row.sender,
    content: JSON.parse(row.content),
    origin_server_ts: row.origin_server_ts,
    room_id: roomId,
  };
}

/** Build the FTS JOIN select query skeleton (without sender/type filters / order / limit). */
export function buildFtsSelectSkeleton(roomCount: number): string {
  return `
    SELECT e.event_id, e.event_type, e.room_id, e.sender, e.origin_server_ts, e.content,
           bm25(events_fts) as rank
    FROM events_fts fts
    JOIN events e ON fts.event_id = e.event_id
    WHERE fts.body MATCH ?
      AND e.room_id IN (${Array.from({ length: roomCount }, () => '?').join(',')})
  `;
}

/** Build the approximate COUNT query for the same FTS match + rooms. */
export function buildFtsCountSkeleton(roomCount: number): string {
  return `
    SELECT COUNT(*) as total
    FROM events_fts fts
    JOIN events e ON fts.event_id = e.event_id
    WHERE fts.body MATCH ?
      AND e.room_id IN (${Array.from({ length: roomCount }, () => '?').join(',')})
  `;
}

/** Helper function to extract highlight terms. Exported for unit tests. */
export function extractHighlights(searchTerm: string): string[] {
  // Split search term into words and return unique terms
  const words = searchTerm.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  return [...new Set(words)];
}

// ============================================
// Endpoints
// ============================================

// POST /_matrix/client/v3/search - Search room events
app.post('/_matrix/client/v3/search', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  // Parse pagination
  const nextBatch = c.req.query('next_batch');

  let body: SearchRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const roomEvents = body.search_categories?.room_events;
  if (!roomEvents) {
    return c.json(emptyRoomEventsResponse());
  }

  const searchTerm = roomEvents.search_term;
  if (isBlankSearchTerm(searchTerm)) {
    return c.json(emptyRoomEventsResponse());
  }

  const filter = roomEvents.filter || {};
  const orderBy = roomEvents.order_by || 'recent';
  const eventContext = roomEvents.event_context;
  const includeState = roomEvents.include_state || false;

  // Get rooms the user is a member of
  const userRooms = await db
    .prepare(
      `
    SELECT room_id FROM room_memberships
    WHERE user_id = ? AND membership IN ('join', 'leave')
  `
    )
    .bind(userId)
    .all<{ room_id: string }>();

  const userRoomIds = new Set(userRooms.results.map((r) => r.room_id));
  const searchRoomIds = applyRoomFilters(userRoomIds, filter);

  if (searchRoomIds.length === 0) {
    return c.json(emptyRoomEventsResponse());
  }

  const limit = SEARCH_PAGE_SIZE;
  const offset = parseSearchOffset(nextBatch);

  // Use FTS5 MATCH for full-text search with BM25 ranking
  const ftsSearchTerm = escapeFtsSearchTerm(searchTerm);

  let query = buildFtsSelectSkeleton(searchRoomIds.length);
  const params: any[] = [ftsSearchTerm, ...searchRoomIds];
  query = appendSenderTypeFilters(query, params, filter);
  query += buildOrderByClause(orderBy);
  query += ` LIMIT ? OFFSET ?`;
  params.push(limit + 1, offset);

  const results = await db
    .prepare(query)
    .bind(...params)
    .all<SearchEventRow>();

  const { page: searchResults, hasMore } = paginateSearchRows(results.results, limit);

  const countQuery = buildFtsCountSkeleton(searchRoomIds.length);
  const countResult = await db
    .prepare(countQuery)
    .bind(ftsSearchTerm, ...searchRoomIds)
    .first<{ total: number }>();
  const totalCount = countResult?.total || 0;

  const formattedResults: SearchResult[] = [];

  for (const event of searchResults) {
    const result = buildSearchResultFromRow(event);

    // Add context if requested
    if (eventContext) {
      const { beforeLimit, afterLimit } = resolveContextLimits(eventContext);

      // Get events before
      const eventsBefore = await db
        .prepare(
          `
        SELECT event_id, event_type, sender, origin_server_ts, content
        FROM events
        WHERE room_id = ? AND origin_server_ts < ?
        ORDER BY origin_server_ts DESC
        LIMIT ?
      `
        )
        .bind(event.room_id, event.origin_server_ts, beforeLimit)
        .all<ContextEventRow>();

      // Get events after
      const eventsAfter = await db
        .prepare(
          `
        SELECT event_id, event_type, sender, origin_server_ts, content
        FROM events
        WHERE room_id = ? AND origin_server_ts > ?
        ORDER BY origin_server_ts ASC
        LIMIT ?
      `
        )
        .bind(event.room_id, event.origin_server_ts, afterLimit)
        .all<ContextEventRow>();

      result.context = {
        events_before: eventsBefore.results
          .reverse()
          .map((e) => formatContextEvent(e, event.room_id)),
        events_after: eventsAfter.results.map((e) => formatContextEvent(e, event.room_id)),
      };

      // Add profile info if requested
      if (eventContext.include_profile) {
        const senders = collectContextSenders(
          event.sender,
          eventsBefore.results,
          eventsAfter.results
        );
        const profiles: Record<string, { displayname?: string; avatar_url?: string }> = {};

        for (const senderId of senders) {
          const profile = await db
            .prepare(
              `
            SELECT display_name, avatar_url FROM users WHERE user_id = ?
          `
            )
            .bind(senderId)
            .first<{ display_name: string | null; avatar_url: string | null }>();

          if (profile) {
            profiles[senderId] = mapUserProfile(profile);
          }
        }

        result.context.profile_info = profiles;
      }
    }

    formattedResults.push(result);
  }

  const highlights = extractHighlights(searchTerm);

  const response: any = {
    search_categories: {
      room_events: {
        results: formattedResults,
        count: totalCount,
        highlights,
      },
    },
  };

  const batch = nextBatchToken(offset, limit, hasMore);
  if (batch !== undefined) {
    response.search_categories.room_events.next_batch = batch;
  }

  // Add room state if requested
  if (includeState && formattedResults.length > 0) {
    const roomIds = uniqueResultRoomIds(formattedResults);
    const state: Record<string, any[]> = {};

    for (const roomId of roomIds) {
      const roomState = await db
        .prepare(
          `
        SELECT e.event_type, e.state_key, e.sender, e.content, e.origin_server_ts
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ?
      `
        )
        .bind(roomId)
        .all<{
          event_type: string;
          state_key: string;
          sender: string;
          content: string;
          origin_server_ts: number;
        }>();

      state[roomId] = roomState.results.map((s) => formatStateEvent(s, roomId));
    }

    response.search_categories.room_events.state = state;
  }

  const groups = buildSearchGroupings(formattedResults, roomEvents.groupings?.group_by);
  if (groups) {
    response.search_categories.room_events.groups = groups;
  }

  return c.json(response);
});

export default app;
