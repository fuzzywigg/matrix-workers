# Tuwunel Issue Registry

Comprehensive issue documentation from a full codebase audit conducted 2026-04-13. Each issue document contains a detailed problem narrative, per-finding breakdowns with file/line references, step-by-step remediation plans, and ideal resolution criteria.

---

## Issue Index

| # | Title | Severity | Domain | Findings |
|---|-------|----------|--------|----------|
| [001](./001-federation-authentication-and-signing.md) | Federation Authentication & Outbound Signing | **Critical** | Federation, Security | 6 |
| [002](./002-authentication-session-security.md) | Authentication & Session Security | **Critical/High** | Auth, Security | 8 |
| [003](./003-media-upload-download-security.md) | Media Upload & Download Security | **High** | Media, Security | 5 |
| [004](./004-database-integrity-and-transaction-safety.md) | Database Integrity & Transaction Safety | **Critical/High** | Database, Integrity | 6 |
| [005](./005-durable-object-lifecycle-memory-management.md) | Durable Object Lifecycle & Memory Management | **High** | Infrastructure, DOs | 10 |
| [006](./006-federation-event-validation-state-resolution.md) | Federation Event Validation & State Resolution | **High** | Federation, Spec | 8 |
| [007](./007-rate-limiting-dos-protection.md) | Rate Limiting & DoS Protection | **High** | Security, Availability | 7 |
| [008](./008-rtc-webrtc-authentication-gap.md) | RTC/WebRTC Authentication Gap | **Critical** | WebRTC, Security | 3 |
| [009](./009-room-operations-race-conditions.md) | Room Operations Race Conditions | **High** | Rooms, Integrity | 5 |
| [010](./010-error-handling-information-leakage.md) | Error Handling & Information Leakage | **Medium** | Errors, Observability | 6 |

**Total: 64 documented findings across 10 issue categories**

---

## Severity Distribution

| Severity | Count | Key Themes |
|----------|-------|-----------|
| **Critical** | 12 | Federation auth bypass, unsigned outbound requests, PDU signature logic error, unauthenticated RTC endpoints, AppService impersonation, stream ordering race condition, body consumption in middleware |
| **High** | 28 | Missing foreign keys, no password policy, brute force unprotected, state resolution incomplete, backfill exposes room history, OIDC weak encryption, upload size bypass, unbounded DO growth, broken alarm scheduling |
| **Medium** | 20 | Timing attacks, CORS permissiveness, stale connection cleanup, information leakage, SSRF IPv6 gaps, cache invalidation, audit trail missing |
| **Low** | 4 | CSP unsafe-inline, thumbnail NaN parsing, negative pagination values, account data races |

---

## Recommended Fix Order

### Phase 1: Critical Security (Immediate)
1. **001** — Federation signing and auth (server cannot safely federate without this)
2. **008** — RTC authentication (call endpoints are completely open)
3. **002.1** — AppService user impersonation
4. **004.1** — Stream ordering race condition

### Phase 2: High-Priority Security & Integrity (Next Sprint)
5. **002.2-002.3** — Password policy and brute force protection
6. **003** — Media upload/download security (all 5 fixes)
7. **004.2-004.3** — Transaction safety and foreign keys
8. **006.1-006.3** — State resolution, backfill access control, invite validation

### Phase 3: Infrastructure Reliability (Following Sprint)
9. **005** — Durable Object lifecycle fixes (all 10)
10. **007** — Rate limiting hardening
11. **009** — Room operation race conditions

### Phase 4: Hardening & Observability
12. **010** — Error handling and audit trails
13. **002.6-002.8** — OIDC encryption, localStorage, CSP
14. **006.6-006.8** — Content hash enforcement, auth chain bounds, SSRF gaps
