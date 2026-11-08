---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1160.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-08T17:11:08-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1160.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-08T17:11:08-03:00"
  "bullmq":
    version: "^6.7.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-08T17:11:08-03:00"
  "@nestjs/bullmq":
    version: "^12.0.1"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-11-08T17:11:08-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T17:10:08-03:00"
---

# Library References — Phase 03 (videos)

Distilled from Context7 for the surfaces the phase's TDs use. Versions verified on npm on 2026-11-08 (`@aws-sdk/client-s3@3.1164.0` latest; `^3.1160.0` pins to a release ≥ 1 week old; `bullmq@6.7.2`; `@nestjs/bullmq@12.0.1`, peer `@nestjs/core ^10 || ^11 || ^12` — compatible with the installed NestJS 11).

Non-npm runtime dependencies fixed by the TDs (no Context7 entry needed): **FFmpeg / ffprobe** from the Debian package of the `node:25.6.0-slim` base image (TD-06); **Redis** `redis:8-alpine` (TD-04); **MinIO** `cgr.dev/chainguard/minio@sha256:a1ac4589a5f8136b616e667b48a0bea9719bb10bd45799ea946f24bbedfafde4` — reports `RELEASE.2026-10-23T20-06-51Z` (TD-03).

### @aws-sdk/client-s3

Used by TD-01, TD-02, TD-03, TD-07, TD-12, TD-14.

- **Reuse clients.** Instantiate `S3Client` once per process and reuse across operations (SDK `EFFECTIVE_PRACTICES.md`: "Avoid instantiating S3Client inside loops"). TD-01 has two singletons: internal I/O client (`endpoint: S3_ENDPOINT`) and offline signing client (`endpoint: S3_PUBLIC_ENDPOINT`).
- **Custom endpoint / MinIO.** `new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`. Path-style is required for MinIO (no virtual-host bucket DNS inside Compose).
- **Default data-integrity checksums.** Current SDK versions add `x-amz-checksum-*` / `x-amz-sdk-checksum-*` headers by default (see `supplemental-docs/MD5_FALLBACK.md`, which strips them for an alternative integrity scheme). For presigned part URLs consumed by a third party (browser) the checksum must not be baked into the signature: configure `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on the clients. Validated by the storage integration test (presigned `UploadPart` with a plain `PUT`).
- **Multipart commands.** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` (presigned, body sent by the client); `ListPartsCommand({ Bucket, Key, UploadId })` → `Parts[{ PartNumber, ETag, Size }]` (resume); `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` (parts ascending); `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` (TD-14).
- **Streaming reads.** `GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1023' })` → `Body` (Node `Readable` in Node.js), `ContentRange`, `ContentLength`, `ContentType`. A body stream can be read **once**: buffer it, pipe it, or discard it with `.destroy()` — never leave it unconsumed (SDK `EFFECTIVE_PRACTICES.md`). Unconsumed bodies hold sockets and can deadlock parallel requests under `maxSockets` limits (`parallel-workloads-node-js.md`) — the stream controller must destroy the body when the HTTP client disconnects.
- **Metadata.** `HeadObjectCommand` → `ContentLength`, `ContentType` (used to answer non-Range requests and validate Range bounds).
- **Bucket bootstrap (TD-03/TD-14).** `HeadBucketCommand` → on `NotFound` `CreateBucketCommand`; `PutBucketCorsCommand` (allowed origin = frontend, methods `PUT`/`GET`/`HEAD`, `ExposeHeaders: ['ETag']`); `PutBucketLifecycleConfigurationCommand({ LifecycleConfiguration: { Rules: [{ ID, Status: 'Enabled', Filter: { Prefix: 'videos/' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] } })`.
- **Writes from the worker.** `PutObjectCommand({ Bucket, Key, Body, ContentType: 'image/jpeg' })` for the thumbnail.

### @aws-sdk/s3-request-presigner

Used by TD-01, TD-06, TD-08.

- `getSignedUrl(client, command, { expiresIn })` signs **any** command; `expiresIn` in seconds (default 900). Signing is local — no network call — which is why the public-endpoint client never needs to reach storage.
- Part URLs: `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: VIDEO_PRESIGN_EXPIRES_SECONDS })`.
- Worker input (TD-06): `getSignedUrl(internalClient, new GetObjectCommand({ Bucket, Key }), { expiresIn })` — signed for the **internal** host so FFmpeg inside the worker container reaches `minio:9000`.
- `signableHeaders` / `unhoistableHeaders` options exist to force headers into the signature; not needed here (no content-type pinning on parts).

### bullmq

Used by TD-04, TD-10.

- Job options on `queue.add(name, data, opts)`: `attempts: 3`, `backoff: { type: 'exponential', delay }`, `jobId` (idempotent enqueue — a job with an existing id is not duplicated), `removeOnComplete` / `removeOnFail`.
- `UnrecoverableError` thrown from the processor moves the job straight to `failed`, ignoring remaining attempts — used for permanent failures (e.g., ffprobe finds no video stream) so they are not retried.
- Worker `'failed'` event: `worker.on('failed', (job, error) => …)`; `job.attemptsMade` vs `job.opts.attempts` tells whether this was the final attempt (TD-10 marks the video `failed` only then).
- Connection: `{ connection: { host, port } }` (ioredis options, bundled dependency).
- `QueueEvents` / `queue.getJobs(['waiting', 'active', ...])` are available for test assertions on enqueued jobs.

### @nestjs/bullmq

Used by TD-04, TD-05.

- Root: `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })`.
- Queue: `BullModule.registerQueue({ name: 'video-processing' })`; inject with `@InjectQueue('video-processing') queue: Queue` (token for tests: `getQueueToken('video-processing')`).
- Consumer: `@Processor('video-processing') class X extends WorkerHost { async process(job: Job): Promise<...> }`; worker events with `@OnWorkerEvent('failed')`. The class must be a provider of a module loaded by the process that should consume — only the worker entrypoint's module registers it (TD-05), the API registers the queue as producer only.
- Processor options via `@Processor({ name, ... }, { concurrency })` (worker options as second argument).
