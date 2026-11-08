# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/12 completed

### SI-03.1 — Infraestrutura Docker (Redis, MinIO, FFmpeg) e configuração
- **Status:** completed
- **Tests:** 12/12 passing (env.validation.integration-spec.ts); app.e2e-spec.ts 1/1 passing
- **Observations:** 
  - MinIO healthcheck uses the `mc` binary bundled in the Chainguard image (`MC_HOST_local` + `mc ready local`) — no extra sidecar.
  - npm resolved `@aws-sdk/*@^3.1164.0` and `bullmq@^6.7.2` (latest), both inside the ranges pinned in library-refs.md.
  - Added `S3_CORS_ALLOWED_ORIGINS` (derived from TD-07 revision ICC-1) to the TD-15 key set, as documented in the plan's Configuration table.

### SI-03.2 — StorageModule: cliente S3, multipart, leitura por Range e bootstrap do bucket
- **Status:** completed
- **Tests:** 14/14 passing (storage.service.integration-spec: 6, storage-bootstrap.service.integration-spec: 3, storage-bootstrap.service.spec: 4, storage.module.spec: 1)
- **Observations:** 
  - MinIO rejects `PutBucketCors` (NotImplemented) and the `AbortIncompleteMultipartUpload` lifecycle action (InvalidArgument): bootstrap applies both on S3 and, on MinIO, logs a warning and relies on server-level `MINIO_API_CORS_ALLOW_ORIGIN` and `MINIO_API_STALE_UPLOADS_EXPIRY=24h` in compose.yaml. Recorded as Revisions on TD-07 and TD-14; the SI-03.2 AC about the rule being on the bucket applies to S3 only.
  - Added a unit spec (`storage-bootstrap.service.spec.ts`) not listed in the plan to cover the supported/unsupported/error branches that real MinIO cannot exercise.

### SI-03.3 — QueueModule: conexão BullMQ e constantes da fila de vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade Video e migration da tabela `videos`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — VideosService: rascunho com URL única e transições de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Início do upload e URLs de partes (POST /videos, GET /videos/:id, GET /videos/:id/upload/parts)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Conclusão e cancelamento do upload com enfileiramento do processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Runtime do worker de vídeo e integração com FFmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Processamento no worker: metadados, thumbnail e ciclo de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Streaming com Range, download e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Pipeline ponta a ponta e contrato OpenAPI
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Documentação de IA e do projeto para a fase de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
