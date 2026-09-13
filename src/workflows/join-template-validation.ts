// Pure make_join template checks (no Workflow runtime dependency).
// Kept separate so unit tests can import without `cloudflare:workers`.

// Supported room versions per Matrix Spec v1.17. Rooms outside this set must be
// rejected — accepting an unknown version means we can't apply the right auth
// rules or event format checks.
export const SUPPORTED_ROOM_VERSIONS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
]);

const EVENT_ID_REGEX = /^\$[A-Za-z0-9+/=_\-.]+(:[A-Za-z0-9.\-]+)?$/;

/**
 * Validate a make_join template returned by a remote server before we sign and
 * send it back. A malicious remote could otherwise feed us empty auth_events
 * (bypassing authorization), a non-positive depth (DAG-ordering corruption),
 * a mismatched room_id (cross-room signature reuse), or a version we don't
 * support (silent room-version downgrade).
 *
 * Throws on validation failure; the workflow's outer catch turns the error
 * into a JoinResult with success=false.
 *
 * Exported for unit tests.
 */
export function validateRemoteJoinTemplate(
  template: { room_version?: unknown; event?: any },
  expectedRoomId: string,
  expectedUserId: string
): void {
  if (!template || typeof template !== 'object') {
    throw new Error('make_join: response is not an object');
  }

  const roomVersion = template.room_version;
  if (typeof roomVersion !== 'string' || !SUPPORTED_ROOM_VERSIONS.has(roomVersion)) {
    throw new Error(`make_join: unsupported room_version ${String(roomVersion)}`);
  }

  const event = template.event;
  if (!event || typeof event !== 'object') {
    throw new Error('make_join: missing event template');
  }

  // room_id must match what we asked to join
  if (event.room_id !== undefined && event.room_id !== expectedRoomId) {
    throw new Error(
      `make_join: room_id mismatch (got ${String(event.room_id)}, expected ${expectedRoomId})`
    );
  }

  // sender / state_key must be the joining user. A spoofed sender lets the
  // remote get us to sign a join event for a different user.
  if (event.sender !== undefined && event.sender !== expectedUserId) {
    throw new Error(`make_join: sender mismatch (got ${String(event.sender)})`);
  }
  if (event.state_key !== undefined && event.state_key !== expectedUserId) {
    throw new Error(`make_join: state_key mismatch (got ${String(event.state_key)})`);
  }

  if (event.type !== undefined && event.type !== 'm.room.member') {
    throw new Error(`make_join: type must be m.room.member (got ${String(event.type)})`);
  }

  if (
    event.content === undefined ||
    typeof event.content !== 'object' ||
    event.content.membership !== 'join'
  ) {
    throw new Error('make_join: content.membership must be "join"');
  }

  // auth_events: must be a non-empty array of valid event IDs
  if (!Array.isArray(event.auth_events) || event.auth_events.length === 0) {
    throw new Error('make_join: auth_events must be a non-empty array');
  }
  for (const id of event.auth_events) {
    if (typeof id !== 'string' || !EVENT_ID_REGEX.test(id)) {
      throw new Error(`make_join: invalid event ID in auth_events: ${String(id)}`);
    }
  }

  // prev_events: must be a non-empty array of valid event IDs
  if (!Array.isArray(event.prev_events) || event.prev_events.length === 0) {
    throw new Error('make_join: prev_events must be a non-empty array');
  }
  for (const id of event.prev_events) {
    if (typeof id !== 'string' || !EVENT_ID_REGEX.test(id)) {
      throw new Error(`make_join: invalid event ID in prev_events: ${String(id)}`);
    }
  }

  // depth: must be a positive integer. A 0 or negative depth corrupts ordering.
  if (
    typeof event.depth !== 'number' ||
    !Number.isFinite(event.depth) ||
    !Number.isInteger(event.depth) ||
    event.depth < 1
  ) {
    throw new Error(`make_join: depth must be a positive integer (got ${String(event.depth)})`);
  }
}
