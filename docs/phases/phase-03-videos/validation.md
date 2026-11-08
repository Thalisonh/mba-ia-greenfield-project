---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T17:38:33-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T17:38:33-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide says storage = local filesystem; TD-13 recommends real MinIO"
    resolved_by: phase-03-videos/TD-13
  - id: AMB-1
    status: resolved
    summary: "'Download do vídeo pelo usuário' — owner only or any viewer?"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-2
    status: resolved
    summary: "Draft pre-registration: which fields are required at upload start?"
    resolved_by: phase-03-videos/TD-08
  - id: MD-1
    status: resolved
    summary: "No decision on cleanup of abandoned multipart uploads / stale drafts"
    resolved_by: phase-03-videos/TD-14
  - id: MD-2
    status: resolved
    summary: "No canonical env-key set for storage + queue (Joi/compose/.env.example)"
    resolved_by: phase-03-videos/TD-15
  - id: DG-1
    status: resolved
    summary: "Inherited global ThrottlerGuard (10 req/60s) would 429 Range streaming"
    resolved_by: clarification
  - id: ICC-1
    status: resolved
    summary: "TD-07 direct-to-storage upload needs storage CORS vs strict-BFF TD-03"
    resolved_by: phase-03-videos/TD-07
  - id: ICC-2
    status: resolved
    summary: "TD-12 API stream endpoint vs strict-BFF: browser player cannot call API"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Object Storage Client SDK and Presign Endpoints"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Object Storage Container Image"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Background Job Queue Technology"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Runtime"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — FFmpeg Integration, Metadata and Thumbnail"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Upload Protocol for Files up to 10GB"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Upload Session Policy"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Processing Trigger after Upload"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Failure Handling"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Test Strategy for Storage, Queue and FFmpeg"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Abandoned Upload Cleanup"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Storage, Queue and Upload Configuration Keys"
    resolved_by: phase-03-videos/TD-15
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (no UI scope in this phase)

## Resolved Issues

Audit trail of the validate ↔ resolve cycle: **validate #1** → 21 open (dirty) · **resolve #1** aborted on MD-1/MD-2 (phase mode: MD-N requires `/research`) · **research** added TD-14/TD-15 · **plan-context** refreshed · **validate #2** → 21 open (MD-1/MD-2 closed, OQ-14/OQ-15 opened) · **resolve #2** applied the user's answers · **validate #3** → clean.

- **MD-1** _(resolved_by phase-03-videos/TD-14)_ — No decision on cleanup of abandoned multipart uploads / stale drafts. New TD added by `/research` after resolve #1 aborted.
- **MD-2** _(resolved_by phase-03-videos/TD-15)_ — No canonical env-key set for storage + queue. New TD added by `/research` after resolve #1 aborted.
- **IC-1** _(resolved_by phase-03-videos/TD-13)_ — Testing guide said storage = local filesystem. User kept TD-13 (real MinIO); `testing-guide-nestjs-project` (`references/external-systems.md`, `SKILL.md` §3, `artifacts/services.md`) updated to "Object Storage — Real MinIO (Docker)".
- **AMB-1** _(resolved_by phase-03-videos/TD-12)_ — Download audience: any viewer (anonymous included) of a `ready` video. Recorded as a Revision on TD-12.
- **AMB-2** _(resolved_by phase-03-videos/TD-08)_ — Pre-registration payload: `filename`, `contentType`, `size` required; `title` optional (defaults to filename without extension). Recorded as a Revision on TD-08.
- **DG-1** _(resolved_by clarification)_ — Video routes opt out of the inherited global `ThrottlerGuard` with `@SkipThrottle()` on the videos controller (same pattern as `AppController`); auth endpoints stay throttled. To be implemented and covered by an e2e test in the plan.
- **ICC-1** _(resolved_by phase-03-videos/TD-07)_ — Strict BFF governs NestJS API calls only; presigned storage URLs are a scoped exception (CORS restricted to the frontend origin, `ETag` exposed). Recorded as a Revision on TD-07.
- **ICC-2** _(resolved_by phase-03-videos/TD-12)_ — Stream/download are a header-transparent backend contract; the future frontend proxies them through BFF Route Handlers forwarding `Range`. Recorded as a Revision on TD-12.
- **OQ-1 … OQ-13** — TD-01 … TD-13 decided by the user (Option A for all; TD-04 = BullMQ on Redis).
- **OQ-14, OQ-15** — TD-14 and TD-15 decided by the user (Option A).
