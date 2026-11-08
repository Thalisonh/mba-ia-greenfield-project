---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-08
scope_description: "Backend foundation for video upload and processing: S3-compatible object storage (MinIO), background job queue, FFmpeg video worker, direct-to-storage multipart upload up to 10GB with draft pre-registration, automatic metadata/thumbnail extraction, unique video URL, Range-based streaming and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (draft pre-registration, multipart upload handshake, streaming/download endpoints), the new Compose infrastructure (object storage, queue broker, video worker) and the worker process that runs FFmpeg.
- `next-frontend/` — no open decision in this document. The video UI is explicitly out of the phase's delivery scope (backend challenge); the upload handshake contract (TD-07/TD-08) is recorded as a backend REST contract the frontend will consume in a later phase.

---

## TD-01: Object Storage Client SDK and Presign Endpoints

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project already targets S3-compatible storage (MinIO locally, S3 in production — see `docs/diagrams/software-arch.mermaid`). What is open is *how* the backend talks to it. A specific constraint of the Docker setup: the API and worker reach MinIO by the Compose service name (`minio:9000`), but presigned URLs are consumed by a client outside the Compose network (browser / host), which can only reach `localhost:9000`. SigV4 signs the `Host` header, so a URL signed for `minio:9000` cannot be rewritten to `localhost:9000` afterwards.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) with two clients
- One `S3Client` pointed at the internal endpoint (`S3_ENDPOINT=http://minio:9000`) for server-side I/O; a second `S3Client` pointed at the public endpoint (`S3_PUBLIC_ENDPOINT`) used only by `getSignedUrl` (signing is offline — no network call). `forcePathStyle: true` for MinIO.
- **Pros:** Same SDK and code path for MinIO and real S3 (production swap is config-only). First-class multipart commands (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`) and generic presigning for any command. Solves the internal/public host split cleanly.
- **Cons:** Large dependency tree (modular, but many packages). Two client instances to wire.

### Option B: MinIO JavaScript client (`minio`)
- MinIO's own SDK, S3-compatible API, has `presignedUrl`, `presignedPutObject`.
- **Pros:** Smaller, simpler API. Built by the storage vendor used locally.
- **Cons:** Presigned *multipart part* URLs are not a first-class API (needs low-level calls). Couples the code to MinIO branding while production targets S3. Same host-split problem still has to be solved by hand.

### Option C: AWS SDK v3 with a single client and a hosts-file alias
- Single client using a hostname that resolves both inside Compose and on the host (e.g., an `/etc/hosts` entry `127.0.0.1 minio`).
- **Pros:** One client.
- **Cons:** Requires manual host configuration on every developer machine — breaks the "everything runs via `docker compose up`" contract; fragile in CI.

**Recommendation:** Option A — the AWS SDK v3 is the only option whose presigner covers multipart part URLs natively and whose code is identical for MinIO and S3; the second, offline-only signing client is the minimal fix for the Compose internal/public host split without touching developer machines.

**Decision:** A (AWS SDK v3 with internal + public signing clients)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails must live in object storage and be addressable from the `videos` table. The layout is a cross-component contract: the API writes the original key at upload start, the worker reads it and writes the thumbnail key, and the delivery endpoints read both. Storage growth/cost is an explicit attention point in `docs/project-plan.md`.

**Options:**

### Option A: Single private bucket, keys derived from the video id
- One bucket (`S3_BUCKET=streamtube`), keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. Keys are persisted in the DB (`storage_key`, `thumbnail_key`).
- **Pros:** One bucket to provision and secure. All artifacts of a video share a prefix — deleting/cleaning a video (Phase 04) is a prefix delete; lifecycle rules (e.g., abort incomplete multipart uploads) apply once. Keys never depend on user input (title/filename), so no sanitization issues.
- **Cons:** Cannot apply different policies per artifact type at bucket level (only per prefix).

### Option B: Two buckets (`videos`, `thumbnails`)
- Originals and thumbnails in separate buckets; thumbnails bucket possibly public-read.
- **Pros:** Per-bucket policies (e.g., public thumbnails served directly).
- **Cons:** Two buckets to provision; a video's artifacts are split; public bucket contradicts the private-by-default stance and bypasses the API's future visibility rules (unlisted videos — Phase 04/05).

### Option C: Keys derived from channel/user + original filename
- E.g., `{channelId}/{originalFilename}`.
- **Pros:** Human-browsable bucket.
- **Cons:** Filename collisions, unsafe characters, renames break keys; leaks user data in keys.

**Recommendation:** Option A — a single private bucket with id-derived keys keeps provisioning to one bucket, makes per-video cleanup a prefix operation, and avoids any dependency on user-supplied names; delivery stays behind the API (TD-11), so no bucket needs to be public.

**Decision:** A (Single private bucket, id-derived keys)

---

## TD-03: Object Storage Container Image

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project plan names MinIO as the local S3. Verified on 2026-11-08: `docker pull minio/minio:<any tag>` and `minio/mc` return "pull access denied / repository does not exist" — MinIO stopped distributing community images in late 2025 (community edition is source-only). The Compose stack still needs a pullable, pinned S3-compatible image. Bucket creation can no longer rely on the `minio/mc` image either.

**Options:**

### Option A: Chainguard MinIO image pinned by digest
- `cgr.dev/chainguard/minio@sha256:<digest>` (free tier only publishes `latest`, so the digest is the pin). Bucket is created idempotently by the application at bootstrap (`HeadBucket` → `CreateBucket`) instead of an `mc` sidecar.
- **Pros:** Still MinIO (same server, same API the plan names); verified pullable; actively rebuilt with security patches; digest pin gives reproducibility. Removing the `mc` dependency simplifies Compose.
- **Cons:** Free tier exposes only `latest` — upgrading means re-pinning the digest manually. Third-party distributor.

### Option B: Build MinIO from source in a local Dockerfile
- Multi-stage build from the last community tag.
- **Pros:** Full control, official source.
- **Cons:** Slow first `docker compose up` (Go build), no upstream security fixes, more Dockerfile maintenance.

### Option C: Different S3-compatible server (SeaweedFS, Garage, RustFS)
- **Pros:** Actively maintained OSS images with tags.
- **Cons:** Diverges from the architecture diagram and the challenge statement (MinIO locally); S3 multipart/presign compatibility must be re-validated per server.

**Recommendation:** Option A — it keeps MinIO as the architecture prescribes with a verified, pullable and patched image; pinning by digest restores reproducibility, and app-side idempotent bucket creation removes the now-unavailable `mc` sidecar.

**Decision:** A (Chainguard MinIO image pinned by digest + app-side bucket bootstrap)

---

## TD-04: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `CLAUDE.md` leave the message queue explicitly as "TBD". Video processing is heavy and must happen off the request path (attention point "Processamento de vídeos"). The queue needs retries with backoff, failure visibility and a NestJS integration. Installed stack: NestJS 11, PostgreSQL 17, no Redis yet. Verified versions (npm, 2026-11-08): `bullmq@6.7.2`, `@nestjs/bullmq@12.0.1` (peer `@nestjs/core ^10 || ^11 || ^12`), `pg-boss@12.38.1`.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed queue; official NestJS module (`BullModule.forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`). Job options `attempts` + `backoff: { type: 'exponential' }`, `removeOnComplete/Fail`, stalled-job recovery.
- **Pros:** Official NestJS recipe (docs.nestjs.com → Queues). Mature (years in production), rich retry/backoff/stalled semantics, sandboxed processors. A dedicated queue service isolates job polling load from the transactional DB. Matches the architecture's separate "Message Queue" container.
- **Cons:** New infrastructure (Redis container) to run and monitor. Redis persistence must be configured (AOF) to not lose jobs on restart.

### Option B: BullMQ with its PostgreSQL backend (`createPostgresBackend`)
- Same BullMQ/NestJS API, storage in a `bullmq` schema of the existing PostgreSQL (introduced in BullMQ 6.0.0, 2026-07-30).
- **Pros:** No new infrastructure; same developer API as Option A.
- **Cons:** Backend is ~3 months old — far less production mileage than the Redis backend. Queue polling load lands on the transactional DB. The architecture diagram models the queue as a separate container.

### Option C: pg-boss
- PostgreSQL-native job queue (`SKIP LOCKED`), retries, expiration, dead-letter.
- **Pros:** No new infrastructure; mature Postgres-based queue; transactional enqueue possible in the same DB transaction as the video update.
- **Cons:** No official NestJS module (manual provider/lifecycle wiring). Same DB-load concern as B.

### Option D: RabbitMQ (`@nestjs/microservices` transport)
- AMQP broker; NestJS microservice transport with `@EventPattern`.
- **Pros:** Real message broker, routing/fan-out, good for future event-driven features.
- **Cons:** Heavier infra; retries/backoff/delays need manual DLX/TTL plumbing — not job-queue semantics out of the box; overkill for a single job type.

**Recommendation:** Option A — BullMQ on Redis is the officially documented NestJS queue, gives retries/exponential backoff/stalled recovery without custom code, and matches the architecture's dedicated queue container; its Postgres backend (B) is attractive but too recent for the project's main stack decision, and pg-boss (C) would require hand-written NestJS integration.

**Decision:** A (BullMQ on Redis)

**Libraries:** bullmq, @nestjs/bullmq

---

## TD-05: Video Worker Runtime

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture diagram has a separate "Video Worker (FFmpeg)" container that consumes the queue and updates DB + storage. The worker needs the `Video` entity, TypeORM config, storage client and queue config — all already in (or added to) `nestjs-project/`. Depends on TD-04.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). Compose service `video-worker` reuses the `nestjs-project` image (with FFmpeg installed) and runs the worker entrypoint. The API process registers the queue as producer only.
- **Pros:** Reuses entities, config namespaces, Joi validation, storage service and migrations — no duplication. Separate container/process: heavy FFmpeg work never competes with HTTP requests, and the worker scales independently. Single lint/tsc/test pipeline.
- **Cons:** API and worker share a dependency set (FFmpeg is installed in the API image too in dev). Shared code must stay process-agnostic.

### Option B: Separate subproject (`video-worker/`)
- A standalone Node project with its own `package.json`.
- **Pros:** Strong isolation; minimal worker image.
- **Cons:** Duplicates entity/config code or requires a shared package (monorepo tooling not in place). Two pipelines to keep green.

### Option C: Processor inside the API process
- `@Processor` registered in the API's module.
- **Pros:** Simplest wiring.
- **Cons:** CPU/IO-heavy FFmpeg runs in the API process — contradicts "sem travar o sistema" and the architecture's separate worker container.

**Recommendation:** Option A — a second entrypoint of the same codebase delivers the architecture's separate worker container while reusing entities/config/storage without a shared-package setup that the monorepo does not have.

**Decision:** A (Same codebase, separate worker entrypoint and Compose service)

---

## TD-06: FFmpeg Integration, Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata and produce a thumbnail. The original may be up to 10GB, so how FFmpeg reads the input matters as much as how it is invoked. Verified 2026-11-08: `fluent-ffmpeg@2.1.3` is deprecated on npm ("Package no longer supported"). Depends on TD-05.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` binaries directly, input = presigned GET URL
- `child_process.spawn('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', url])` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=...` to a JPEG on stdout/tmp, then upload. FFmpeg's HTTP demuxer issues Range requests, so only the container header and the target frame region are fetched — no full download of the 10GB file.
- **Pros:** No wrapper dependency (FFmpeg from the OS package). JSON output from ffprobe is structured and typed by us. Range-based reads keep worker disk/network usage bounded. Thumbnail frame chosen with fast input seeking (`-ss` before `-i`).
- **Cons:** We own argument building and process error handling. Presigned URL must outlive the job.

### Option B: `fluent-ffmpeg` wrapper, input downloaded to a temp file
- Download the object to worker disk, process with the fluent API.
- **Pros:** Fluent API, familiar.
- **Cons:** Library deprecated/unmaintained. Full 10GB download per job — disk and time cost.

### Option C: `ffmpeg.wasm`
- **Pros:** No native binary.
- **Cons:** Order of magnitude slower, memory-bound (cannot handle multi-GB inputs).

**Recommendation:** Option A — spawning the OS FFmpeg binaries avoids a deprecated wrapper, and feeding them a presigned URL lets FFmpeg range-read only what it needs from a 10GB object; the thumbnail is taken from the frame at 10% of the duration (capped to the first frames for very short clips) to avoid black intro frames, scaled to 1280px wide JPEG.

**Decision:** A (Spawn ffprobe/ffmpeg on presigned URL input)

---

## TD-07: Upload Protocol for Files up to 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The upload must not hold the API while 10GB are transferred, and `docs/project-plan.md` (Pontos de Atenção) asks for resumability after connection failure. S3 limits (AWS docs, "Amazon S3 multipart upload limits"): max 10,000 parts, part size 5 MiB–5 GiB (last part exempt), and a single PUT tops out at 5GB — so a single request cannot carry 10GB. The upload handshake is a contract the (future) frontend will implement. Depends on TD-01.

**Options:**

### Option A: Direct-to-storage S3 multipart upload with presigned part URLs
- API starts the multipart upload (`CreateMultipartUpload`), returns presigned `UploadPart` URLs; the client PUTs each part straight to storage, then calls the API to complete (`CompleteMultipartUpload` with the part ETags).
- **Pros:** Zero video bytes through the API — only small JSON handshakes. Native S3 semantics, works identically on S3. Resumable: failed parts are retried individually, and `ListParts` tells which parts already landed. Parallel part uploads.
- **Cons:** Multi-step client protocol. Storage must expose CORS `ETag` header to browsers (configured on the bucket/server). Incomplete uploads leave orphan parts (need abort/lifecycle cleanup).

### Option B: tus resumable protocol through the API (`@tus/server` + S3 store)
- Client speaks tus to an API endpoint, which streams chunks into S3.
- **Pros:** Standard resumable protocol with mature clients (`tus-js-client`, Uppy).
- **Cons:** Every byte transits the API process (bandwidth + event-loop pressure on the API for 10GB uploads) — exactly what the capability asks to avoid. Additional protocol server inside NestJS/Express.

### Option C: Single presigned PUT
- **Pros:** Simplest client.
- **Cons:** Hard 5GB ceiling per PUT — cannot satisfy 10GB. Not resumable.

### Option D: Multipart/form-data streamed through the API
- **Pros:** Familiar.
- **Cons:** API holds the connection for the whole transfer; no resumability; same API-load problem as B.

**Recommendation:** Option A — presigned multipart is the only option that meets 10GB (C cannot), keeps the API out of the data path (B and D cannot), and gives part-level resumability natively on both MinIO and S3.

**Decision:** A (Direct-to-storage S3 multipart with presigned part URLs)

**Revisions:**
- 2026-11-08 — Strict BFF (`next-frontend-config-base/TD-03`) governs calls to the NestJS API only; presigned storage URLs are a scoped, short-lived exception: storage CORS is restricted to the frontend origin and exposes the `ETag` header. Rationale: resolves `phase-03-videos` ICC-1 — routing 10GB through the BFF/API would contradict the capability.
- 2026-11-08 — MinIO has no per-bucket CORS (`PutBucketCors` → `NotImplemented`); locally the restriction to the frontend origin is `MINIO_API_CORS_ALLOW_ORIGIN` in `compose.yaml`, while on S3 the bootstrap applies the bucket CORS rule from `S3_CORS_ALLOWED_ORIGINS`. Rationale: found while implementing SI-03.2 against the real server.

---

## TD-08: Upload Session Policy (part URLs, limits, expiry)

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** With TD-07 the API must decide when part URLs are issued and which limits apply. These values are cross-component (Joi env schema, DTO validation, API contract). Depends on TD-07.

**Options:**

### Option A: Fixed part size, part URLs issued on demand in batches
- `POST /videos` validates `{ title, filename, contentType, size }` (size ≤ 10 GiB, `video/*` MIME), creates the draft and the multipart upload, returns `partSize` + `partCount`. `GET /videos/:id/upload/parts?from=&to=` returns presigned URLs for a range of part numbers plus the parts already uploaded (via `ListParts`). Part size 64 MiB (10 GiB → 160 parts), URL expiry 1h.
- **Pros:** URLs stay short-lived (only the batch in use is signed). Resume = ask again for missing parts after reconnect. Bounded response sizes.
- **Cons:** One extra endpoint; client loops over batches.

### Option B: All part URLs returned at initiation
- `POST /videos` returns every presigned part URL up front.
- **Pros:** Single call before uploading.
- **Cons:** Long-lived URLs are needed for slow 10GB uploads (larger exposure window); resume after expiry requires a new endpoint anyway; large response.

### Option C: Client-chosen part size
- **Pros:** Client can tune for its bandwidth.
- **Cons:** Must validate against S3 limits per request; inconsistent sessions; harder to test.

**Recommendation:** Option A — on-demand, range-scoped part URLs keep signatures short-lived and make resume a natural "ask for the missing parts" call; a fixed 64 MiB part size keeps a 10 GiB file at 160 parts, far under the 10,000-part limit and above the 5 MiB minimum.

**Decision:** A (Fixed 64 MiB parts, on-demand part URL batches, 1h expiry)

**Revisions:**
- 2026-11-08 — Pre-registration payload: `filename`, `contentType` and `size` are required; `title` is optional and defaults to the filename without extension (title/description editing is Phase 04). Rationale: resolves `phase-03-videos` AMB-2.

---

## TD-09: Processing Trigger after Upload

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload finishes. Someone must detect "upload finished" and enqueue the job. Depends on TD-04 and TD-07.

**Options:**

### Option A: API completion endpoint enqueues the job
- `POST /videos/:id/upload/complete` (owner only) calls `CompleteMultipartUpload`, sets status `processing`, enqueues `video.process` with `jobId = videoId`.
- **Pros:** The API must call `CompleteMultipartUpload` anyway (TD-07), so it already knows the exact moment. Ownership/state validated in one place. `jobId = videoId` makes enqueue idempotent. Testable via supertest.
- **Cons:** If the client never calls complete, the video stays a draft (acceptable — it really isn't uploaded).

### Option B: Storage bucket notifications (MinIO/S3 events → queue/webhook)
- Configure an `s3:ObjectCreated:CompleteMultipartUpload` notification to Redis/webhook.
- **Pros:** Decoupled from the client calling the API.
- **Cons:** Requires server-side notification configuration (MinIO admin config, SQS/EventBridge on AWS — different per environment). The client still has to send the ETags to complete the multipart upload, so the API call happens anyway.

**Recommendation:** Option A — completing a multipart upload already requires an API call with the part ETags, so the same endpoint is the natural, environment-independent trigger; bucket notifications would add per-environment configuration for no extra guarantee.

**Decision:** A (API completion endpoint enqueues the job)

---

## TD-10: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is created as a draft at upload start and must reflect processing progress and failures in the DB. Phase 04 will add publication/visibility on top of this. Depends on TD-04 and TD-09.

**Options:**

### Option A: Single status enum + retries with backoff, terminal `failed`
- `status` enum `draft → processing → ready | failed`; job options `attempts: 3`, exponential backoff; on the last failed attempt the worker sets `failed` and stores `processing_error` (text). Only `ready` videos are streamable/downloadable.
- **Pros:** One column answers "what can I do with this video". Transient failures (network blips to storage) recover automatically; permanent ones (corrupt file) end visibly. Simple to test.
- **Cons:** Upload state and processing state share one column (fine while publication is a Phase 04 concern).

### Option B: Separate `upload_status` and `processing_status` columns
- **Pros:** Orthogonal states, finer reporting.
- **Cons:** Invalid combinations possible; more states to test; no capability needs the extra granularity now.

### Option C: Single attempt, `failed` on first error
- **Pros:** Simplest.
- **Cons:** Transient storage/network errors permanently fail a 10GB upload.

**Recommendation:** Option A — a single enum maps 1:1 to the lifecycle the phase describes (rascunho → processando → pronto/erro), and bounded retries with exponential backoff absorb transient errors while still ending in a visible `failed` state with the error message persisted.

**Decision:** A (Single status enum + 3 attempts with exponential backoff, terminal failed)

---

## TD-11: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, never-conflicting URL (attention point "URLs únicas"). The identifier appears in public routes (`/videos/{slug}/stream`), so it must not leak sequence/volume and must be URL-safe. Phase 02 already uses a "unique column + retry on collision" pattern for channel nicknames (SAVEPOINT retry, `.claude/rules/typeorm-queries.md`).

**Options:**

### Option A: Random 11-char base62 slug (`crypto.randomInt`) + unique index + retry
- Generated with Node `crypto` (no dependency); ~65 bits of entropy (62^11); DB unique constraint is the source of truth, insert retried on `23505`.
- **Pros:** Short, URL-safe, non-enumerable. Collision probability negligible and still handled by the constraint. Reuses the Phase 02 retry pattern. No dependency.
- **Cons:** Retry logic required (already a known pattern).

### Option B: Expose the UUID primary key
- **Pros:** Zero extra code; uniqueness guaranteed.
- **Cons:** 36-char URLs — contradicts "URL curta". Couples public URLs to the internal PK.

### Option C: Sqids/Hashids encoding of a sequential id
- **Pros:** Short, deterministic, no collision.
- **Cons:** Requires a sequential column (PK is UUID); reversible/enumerable with the alphabet; extra dependency.

**Recommendation:** Option A — an 11-char base62 slug from Node's `crypto` gives YouTube-length, non-enumerable URLs with no dependency, and the DB unique constraint + retry pattern already established in Phase 02 guarantees no conflict.

**Decision:** A (11-char base62 slug + unique index + retry)

---

## TD-12: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and users must be able to download it. Anonymous users can watch (project overview), and Phase 04/05 will add visibility rules (unlisted). Depends on TD-02 and TD-11.

**Options:**

### Option A: API proxies storage with HTTP Range support (206 Partial Content)
- `GET /videos/:slug/stream` forwards the client's `Range` header to `GetObject({ Range })` and pipes the body with `206`, `Content-Range`, `Accept-Ranges: bytes`; no Range → `200` full stream. `GET /videos/:slug/download` streams with `Content-Disposition: attachment`. Thumbnail served the same way.
- **Pros:** Storage stays private; single public origin; every request passes through API rules (status `ready` now, visibility later). Node streams pipe without buffering — memory stays flat. Range contract is testable end-to-end with supertest.
- **Cons:** Video bandwidth flows through the API (mitigated in production by a CDN in front of the endpoint, or by switching to Option B behind the same route).

### Option B: Redirect (302) to a short-lived presigned GET URL
- API checks rules then redirects; storage serves Range requests itself.
- **Pros:** No video bytes through the API.
- **Cons:** Exposes storage host to clients (needs public endpoint, CORS); URLs expire mid-playback for long videos; harder to assert the Range contract in API tests.

### Option C: HLS/DASH adaptive streaming (transcode to segments)
- **Pros:** Adaptive bitrate, industry standard for large platforms.
- **Cons:** Transcoding pipeline is far beyond the phase (heavy worker work, storage multiplication); progressive MP4 with Range already satisfies "sem necessidade de download completo".

**Recommendation:** Option A — proxying with Range/206 meets the streaming capability with progressive playback, keeps the bucket private and every byte behind API rules that Phase 04/05 will extend, and is fully testable; Option B remains a drop-in optimization behind the same routes if bandwidth becomes a concern.

**Decision:** A (API proxy with HTTP Range / 206 Partial Content)

**Revisions:**
- 2026-11-08 — Stream and download are open to any viewer, anonymous included, for `ready` videos. Rationale: resolves `phase-03-videos` AMB-1 (project overview: anonymous users watch freely; Phase 05 places the download button on the anonymous view page).
- 2026-11-08 — The routes are a header-transparent backend contract: the future frontend exposes them through BFF Route Handlers that forward `Range` and pipe the body (Strict BFF, `next-frontend-config-base/TD-03`). Rationale: resolves `phase-03-videos` ICC-2.

---

## TD-13: Test Strategy for Storage, Queue and FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Phase 03 adds three external systems. The project's testing pyramid (`testing-guide-nestjs-project`) requires integration tests against real dependencies; the challenge explicitly asks not to mock what the Compose infra can run. Test media is needed for FFmpeg.

**Options:**

### Option A: Real MinIO/Redis/FFmpeg from Compose + synthetic media generated at test time
- Integration/e2e tests hit `minio` and `redis` services; test videos are generated on the fly with `ffmpeg -f lavfi -i testsrc` (a few seconds, small) in the test setup. Unit tests mock collaborators as today.
- **Pros:** Exercises the real S3 multipart and Range behavior, real BullMQ semantics and real FFmpeg output. No binary fixtures in git.
- **Cons:** Tests require the full Compose stack and FFmpeg in the test container; slower than mocks.

### Option B: Mock S3 (`aws-sdk-client-mock`) and queue in integration tests
- **Pros:** Fast, no infra.
- **Cons:** Does not catch real S3/MinIO behavior (presign host, ETag/CORS, Range); contradicts the project's integration-test definition.

### Option C: Real infra + committed binary fixture video
- **Pros:** Deterministic media.
- **Cons:** Binary blobs in git; FFmpeg is already required by the worker, so generation is free.

**Recommendation:** Option A — the Compose stack already provides MinIO, Redis and an FFmpeg-enabled image, so integration and e2e tests exercise the real multipart/Range/queue behavior, and generating a few-second `testsrc` clip at setup avoids committing binaries.

**Decision:** A (Real Compose infra + synthetic lavfi media)

---

## TD-14: Abandoned Upload Cleanup

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Added after `plan-validate` MD-1. With TD-07, a client that starts an upload and never completes it leaves uploaded parts in storage (they count toward storage usage until the multipart upload is aborted) and a `draft` row in the DB. `docs/project-plan.md` → Pontos de Atenção calls out storage growth/cost. Depends on TD-07 and TD-10.

**Options:**

### Option A: Explicit cancel endpoint + bucket lifecycle rule
- `DELETE /videos/:id/upload` (owner, draft only) calls `AbortMultipartUpload` and deletes the draft row. At bootstrap, the storage service applies a bucket lifecycle rule `AbortIncompleteMultipartUpload` (`DaysAfterInitiation: 1`) under the `videos/` prefix, so uploads abandoned without a cancel call are purged by the storage itself.
- **Pros:** Uses standard S3 lifecycle semantics (identical on S3 and MinIO) — no scheduler to run. Client-initiated cancel frees storage immediately. Lifecycle config is code-owned and idempotent (applied with the bucket bootstrap of TD-03).
- **Cons:** Draft rows of abandoned uploads remain in the DB (harmless: never streamable; Phase 04's draft management can list/delete them).

### Option B: Scheduled cleanup job on the queue
- A BullMQ repeatable job aborts multipart uploads and deletes drafts older than N hours.
- **Pros:** Also cleans DB drafts; full control.
- **Cons:** Another job type, scheduling and tests; duplicates what storage lifecycle already provides for parts.

### Option C: No cleanup in this phase
- **Pros:** Zero work.
- **Cons:** Orphan parts accumulate indefinitely — directly contradicts the storage-cost attention point.

**Recommendation:** Option A — a cancel endpoint plus a code-applied `AbortIncompleteMultipartUpload` lifecycle rule bounds storage leaks with standard S3 behavior and no scheduler; leftover draft rows are inert and are the natural input of Phase 04's draft management.

**Decision:** A (Cancel endpoint + AbortIncompleteMultipartUpload lifecycle rule)

**Revisions:**
- 2026-11-08 — On MinIO the `AbortIncompleteMultipartUpload` lifecycle action is rejected (`InvalidArgument`); MinIO purges stale multipart uploads server-side (`stale_uploads_expiry`, verified with `mc admin config get`). The bootstrap still applies the rule on S3 and, on MinIO, relies on `MINIO_API_STALE_UPLOADS_EXPIRY=24h` pinned in `compose.yaml` — same 1-day bound. Rationale: found while implementing SI-03.2 against the real server.

---

## TD-15: Storage, Queue and Upload Configuration Keys

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Added after `plan-validate` MD-2. The new runtime configuration is cited in three files that must stay consistent — Joi schema (`src/config/env.validation.ts`), `compose.yaml` and `.env.example` — and consumed by both the API and the worker (TD-05). The inherited convention requires one `registerAs` namespace per domain in `src/config/`. Depends on TD-01, TD-04, TD-08.

**Options:**

### Option A: Provider-neutral `S3_*` keys + `REDIS_*` keys + `VIDEO_*` policy keys, three namespaces
- `storage` namespace (`storage.config.ts`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`. `queue` namespace (`queue.config.ts`): `REDIS_HOST`, `REDIS_PORT`. `video` namespace (`video.config.ts`): `VIDEO_MAX_UPLOAD_BYTES` (10 GiB), `VIDEO_UPLOAD_PART_SIZE_BYTES` (64 MiB), `VIDEO_PRESIGN_EXPIRES_SECONDS` (3600). Hosts default to Compose service names (`minio`, `redis`).
- **Pros:** Same keys for MinIO and AWS S3 (prod swap is values-only). One file per domain, matching the inherited convention. Policy values from TD-08 become tunable without code changes, validated with bounds by Joi (part size ≥ 5 MiB).
- **Cons:** More keys to document.

### Option B: Vendor-specific `MINIO_*` keys
- **Pros:** Mirrors local tooling names.
- **Cons:** Misleading in production (S3); renaming later breaks every environment.

### Option C: Single `video` namespace holding storage, queue and policy
- **Pros:** Fewer files.
- **Cons:** Mixes three domains, against the one-namespace-per-domain convention; storage/queue are reused by later phases beyond videos.

**Recommendation:** Option A — provider-neutral `S3_*` keys keep the MinIO→S3 swap a values-only change, and three `registerAs` namespaces follow the inherited one-file-per-domain convention while exposing TD-08's limits as validated, tunable settings shared by API and worker.

**Decision:** A (S3_* + REDIS_* + VIDEO_* keys in storage/queue/video namespaces)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Client SDK and Presign Endpoints | AWS SDK v3 with internal + public (signing) clients | A (AWS SDK v3 with internal + public signing clients) |
| TD-02 | Backend | Bucket and Object Key Layout | Single private bucket, id-derived keys | A (Single private bucket, id-derived keys) |
| TD-03 | Repo-wide | Object Storage Container Image | Chainguard MinIO pinned by digest + app-side bucket creation | A (Chainguard MinIO image pinned by digest + app-side bucket bootstrap) |
| TD-04 | Backend | Background Job Queue Technology | BullMQ on Redis | A (BullMQ on Redis) |
| TD-05 | Repo-wide | Video Worker Runtime | Same codebase, separate entrypoint + Compose service | A (Same codebase, separate worker entrypoint and Compose service) |
| TD-06 | Backend | FFmpeg Integration, Metadata and Thumbnail | Spawn ffprobe/ffmpeg on presigned URL input | A (Spawn ffprobe/ffmpeg on presigned URL input) |
| TD-07 | Backend | Upload Protocol for Files up to 10GB | Direct S3 multipart with presigned part URLs | A (Direct-to-storage S3 multipart with presigned part URLs) |
| TD-08 | Backend | Upload Session Policy | Fixed 64 MiB parts, on-demand part URL batches, 1h expiry | A (Fixed 64 MiB parts, on-demand part URL batches, 1h expiry) |
| TD-09 | Backend | Processing Trigger after Upload | API completion endpoint enqueues job | A (API completion endpoint enqueues the job) |
| TD-10 | Backend | Video Status Lifecycle and Failure Handling | Single enum + 3 attempts with exponential backoff | A (Single status enum + 3 attempts with exponential backoff, terminal failed) |
| TD-11 | Backend | Unique Video URL Identifier | 11-char base62 slug + unique index + retry | A (11-char base62 slug + unique index + retry) |
| TD-12 | Backend | Streaming and Download Delivery | API proxy with Range/206 | A (API proxy with HTTP Range / 206 Partial Content) |
| TD-13 | Backend | Test Strategy for Storage, Queue and FFmpeg | Real Compose infra + synthetic lavfi media | A (Real Compose infra + synthetic lavfi media) |
| TD-14 | Backend | Abandoned Upload Cleanup | Cancel endpoint + `AbortIncompleteMultipartUpload` lifecycle rule | A (Cancel endpoint + AbortIncompleteMultipartUpload lifecycle rule) |
| TD-15 | Repo-wide | Storage, Queue and Upload Configuration Keys | `S3_*` + `REDIS_*` + `VIDEO_*` keys in three namespaces | A (S3_* + REDIS_* + VIDEO_* keys in storage/queue/video namespaces) |
