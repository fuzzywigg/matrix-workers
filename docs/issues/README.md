# Tuwunel Issue Registry

Comprehensive issue documentation from a full codebase audit conducted 2026-04-13. Each issue document contains a detailed problem narrative, per-finding breakdowns with file/line references, step-by-step remediation plans, and ideal resolution criteria.

**Last updated:** 2026-05-11

---

## Resolution Status

Of the 64 original findings, **64 have been resolved** across 11 commits on branch `claude/review-and-document-issues-Uy4oU`:

| Status | Count |
|--------|-------|
| Resolved | 64 |
| Remaining | 0 |

---

## Issue Index

| # | Title | Severity | Findings | Resolved | Status |
|---|-------|----------|----------|----------|--------|
| [001](./001-federation-authentication-and-signing.md) | Federation Auth & Outbound Signing | **Critical** | 6 | 6 | **Done** |
| [002](./002-authentication-session-security.md) | Authentication & Session Security | **Critical/High** | 8 | 8 | **Done** |
| [003](./003-media-upload-download-security.md) | Media Upload & Download Security | **High** | 5 | 5 | **Done** |
| [004](./004-database-integrity-and-transaction-safety.md) | Database Integrity & Transaction Safety | **Critical/High** | 6 | 6 | **Done** |
| [005](./005-durable-object-lifecycle-memory-management.md) | Durable Object Lifecycle & Memory | **High** | 10 | 10 | **Done** |
| [006](./006-federation-event-validation-state-resolution.md) | Federation Event Validation | **High** | 8 | 8 | **Done** |
| [007](./007-rate-limiting-dos-protection.md) | Rate Limiting & DoS Protection | **High** | 7 | 7 | **Done** |
| [008](./008-rtc-webrtc-authentication-gap.md) | RTC/WebRTC Auth Gap | **Critical** | 3 | 3 | **Done** |
| [009](./009-room-operations-race-conditions.md) | Room Operations Race Conditions | **High** | 5 | 5 | **Done** |
| [010](./010-error-handling-information-leakage.md) | Error Handling & Information Leakage | **Medium** | 6 | 6 | **Done** |

---

## What Was Fixed

### Commit 1: Initial security fixes (8 files)
- **008**: All 3 findings — requireAuth() on LiveKit, OpenID verification, CORS
- **003**: All 5 findings — MIME whitelist, body size, filename sanitization, security headers, NaN parsing
- **002**: Items 1, 4, 5, 7 — AppService namespace validation, PBKDF2 bounds, timing-safe comparison, CSP note
- **005**: Item 3 — RateLimit alarm scheduling
- **007**: Item 7 — Pagination parameter bounds
- **010**: Item 2 — Cache invalidation error logging

### Commit 2: Federation signing and body buffering (4 files)
- **001**: Items 1, 2, 4 — Outbound signing on workflows/DOs, body buffering in auth middleware, optional auth fix
- **005**: Items 4, 5 — FederationDO queue bounds (10k cap), response body validation, max retry cap (32), fetch timeouts

### Commit 3: Database integrity (2 files)
- **004**: Items 1, 3 — Stream ordering atomic UPDATE, data integrity migration with indexes and unique constraints

### Commit 4: Federation event validation (1 file)
- **006**: Items 1, 2, 3, 7, 4 — PDU signature logic fix, backfill/missing-events membership checks, auth chain cap, invite sender validation

### Commit 5: Durable Object reliability (3 files)
- **005**: Items 2, 8, 9 — SyncDO bounded scans, connection state expiry, PushDO JWT TTL reduction, push fetch timeout

### Commit 6: Password and brute force protection (5 files)
- **002**: Items 2, 3, 6 — Password strength validation, per-account lockout after 5 failures, OIDC encryption key required for new secrets
- **007**: Item 4 — Sliding sync subscription cap (100 per request)

### Commit 7: SSRF and error sanitization (2 files)
- **006**: Item 8 — IPv6 multicast, site-local, documentation prefix ranges added to SSRF blocklist
- **010**: Item 1 — Raw error details removed from admin API OIDC responses, logged server-side instead

### Commit 8: Review feedback fixes (4 files)
- **001**: Item 3 — PDU signature logic fixed (removed `&& pduOrigin !== origin` exception)
- **006**: Items 2, 2 — LIKE suffix vulnerability replaced with exact SUBSTR domain check in backfill and get_missing_events
- **005**: Item 4 — DO `list()` explicit limit=10000 for queue size cap

### Commit 9–10: Package lock revert and registry update
- Reverted cosmetic changes to package-lock.json that triggered Dependency Review CI
- Updated issue registry to 52/64

### Commit 11: Remaining 12 findings resolved (10 files + 1 migration)
- **004**: Items 2, 4, 5 — Room creation atomicity via D1 `batch()`, D1 row size validation (500 KB limit), N+1 query in sliding sync replaced with `db.batch()`
- **005**: Items 1, 7 — SyncDO resolver race fixed with Map-keyed resolvers, RoomDO WebSocket connection cap (500)
- **001**: Item 5 — Federation key staleness threshold (7-day max, rejects stale fallback)
- **006**: Items 5, 6 — Join template validation (auth_events, prev_events, depth, room_id checks), content hash required for room versions 4+
- **007**: Item 1 — Rate limit IP detection uses only CF-Connecting-IP (removed X-Forwarded-For spoofing vector)
- **009**: Items 1–5 — Room creation atomicity (batch), cache invalidation logging, account data upsert already in place, join idempotency via INSERT OR IGNORE; DurableObject serialization via existing RoomDO
- **010**: Item 5 — Admin audit log table (migration 017), `logAdminAction()` added to password reset, deactivate, remove_admin, and purge operations

---

## All 64 Findings Resolved

All issues from the 2026-04-13 audit are now addressed. The codebase has been hardened across:
- Federation authentication and signing (Ed25519 X-Matrix headers on all outbound requests)
- Request body buffering (prevents empty body from consumed stream)
- Database atomicity (D1 batch(), atomic stream ordering, row size validation)
- Durable Object reliability (Map-keyed resolvers, connection caps, bounded storage scans)
- Rate limiting (CF-Connecting-IP only, brute force lockout, subscription caps)
- Federation event validation (signature checks, membership proofs, content hash enforcement)
- Error handling (no raw error details in responses, admin audit trail)
- Media security (MIME whitelist, upload size validation, filename sanitization)
- SSRF protection (comprehensive IPv4 + IPv6 blocklist)
- Password security (strength validation, PBKDF2 bounds, timing-safe comparisons)
