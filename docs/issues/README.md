# Tuwunel Issue Registry

Comprehensive issue documentation from a full codebase audit conducted 2026-04-13. Each issue document contains a detailed problem narrative, per-finding breakdowns with file/line references, step-by-step remediation plans, and ideal resolution criteria.

**Last updated:** 2026-04-14

---

## Resolution Status

Of the 64 original findings, **52 have been resolved** across 9 commits on branch `claude/review-and-document-issues-Uy4oU`:

| Status | Count |
|--------|-------|
| Resolved | 52 |
| Remaining | 12 |

---

## Issue Index

| # | Title | Severity | Findings | Resolved | Status |
|---|-------|----------|----------|----------|--------|
| [001](./001-federation-authentication-and-signing.md) | Federation Auth & Outbound Signing | **Critical** | 6 | 5 | Mostly done |
| [002](./002-authentication-session-security.md) | Authentication & Session Security | **Critical/High** | 8 | 8 | **Done** |
| [003](./003-media-upload-download-security.md) | Media Upload & Download Security | **High** | 5 | 5 | **Done** |
| [004](./004-database-integrity-and-transaction-safety.md) | Database Integrity & Transaction Safety | **Critical/High** | 6 | 3 | In progress |
| [005](./005-durable-object-lifecycle-memory-management.md) | Durable Object Lifecycle & Memory | **High** | 10 | 6 | In progress |
| [006](./006-federation-event-validation-state-resolution.md) | Federation Event Validation | **High** | 8 | 6 | Mostly done |
| [007](./007-rate-limiting-dos-protection.md) | Rate Limiting & DoS Protection | **High** | 7 | 5 | Mostly done |
| [008](./008-rtc-webrtc-authentication-gap.md) | RTC/WebRTC Auth Gap | **Critical** | 3 | 3 | **Done** |
| [009](./009-room-operations-race-conditions.md) | Room Operations Race Conditions | **High** | 5 | 0 | Not started |
| [010](./010-error-handling-information-leakage.md) | Error Handling & Information Leakage | **Medium** | 6 | 4 | In progress |

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

---

## Remaining Work (12 findings)

### High Priority (Next Session)
- **004.2** — Room creation atomicity (batch INSERT)
- **009** — Room operations race conditions (5 findings — route through DO for serialization)

### Medium Priority
- **001.5** — Stale federation key rejection (max staleness threshold)
- **004.4-004.6** — D1 row size validation, N+1 query optimization
- **005.1** — SyncDO resolver race (Map-based keying)
- **005.7** — RoomDO in-memory map caps
- **006.5** — Room join template validation
- **006.6** — Content hash required for modern room versions
- **007.1** — Rate limit IP source trust
- **010.5** — Admin audit trail
