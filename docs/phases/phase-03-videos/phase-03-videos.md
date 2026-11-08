---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T17:12:54-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-08T17:11:41-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T17:10:08-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB sem travar a API (multipart pré-assinado direto ao object storage, com pré-cadastro do vídeo como rascunho), o processamento automático em segundo plano por fila e worker FFmpeg (duração, metadados e thumbnail), a URL única por vídeo e a entrega por streaming com Range e download — com storage (MinIO), fila (Redis/BullMQ) e worker subindo no Docker Compose do `nestjs-project/`.

---

## Step Implementations

### SI-03.1 — Infraestrutura Docker (Redis, MinIO, FFmpeg) e configuração

**Description:** Sobe o object storage e o broker da fila no Compose, instala FFmpeg na imagem e as libs fixadas, e cria os namespaces de configuração `storage`, `queue` e `video` — a base que todos os SIs seguintes consomem.

**Technical actions:**

1. Atualizar `nestjs-project/Dockerfile.dev` — adicionar `ffmpeg` ao `apt install` (fornece `ffmpeg`/`ffprobe` para API, worker e testes) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-13`)
2. Atualizar `nestjs-project/compose.yaml` — serviço `redis` (`redis:8-alpine`, `redis-server --appendonly yes`, healthcheck `redis-cli ping`, volume `redis-data`) e serviço `minio` (`cgr.dev/chainguard/minio@sha256:a1ac4589a5f8136b616e667b48a0bea9719bb10bd45799ea946f24bbedfafde4`, `server /data --console-address :9001`, portas `9000`/`9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, healthcheck `mc ready local` com `MC_HOST_local`, volume `minio-data`); `nestjs-api` passa a depender de ambos `service_healthy` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
3. Instalar `@aws-sdk/client-s3@^3.1160.0`, `@aws-sdk/s3-request-presigner@^3.1160.0`, `bullmq@^6.7.0`, `@nestjs/bullmq@^12.0.1` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`; versões em `library-refs.md`)
4. Criar `src/config/storage.config.ts`, `src/config/queue.config.ts`, `src/config/video.config.ts` (`registerAs`) com as chaves e defaults de `### Data Model → Configuration`; registrar no `load` do `ConfigModule` (per `phase-03-videos/TD-15`, convenção herdada de `registerAs` por domínio)
5. Atualizar `src/config/env.validation.ts` (Joi: `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` obrigatórios, `VIDEO_UPLOAD_PART_SIZE_BYTES` ≥ 5242880, demais com default) e `.env.example` com todas as chaves novas apontando para os nomes de serviço do Compose (`minio`, `redis`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Joi env schema (`storage`/`queue`/`video`) | Integration: validação real do schema | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` em `nestjs-project/` deixa `redis` e `minio` com status `healthy` e `nestjs-api` em execução
- `docker compose exec nestjs-api ffprobe -version` imprime a versão do FFmpeg
- Validar o ambiente sem `S3_ACCESS_KEY_ID` falha com erro Joi citando a chave
- `VIDEO_UPLOAD_PART_SIZE_BYTES=1048576` (1 MiB) é rejeitado pela validação; o valor default `67108864` é aceito
- `GET /` continua retornando `200` com a stack nova

---

### SI-03.2 — StorageModule: cliente S3, multipart, leitura por Range e bootstrap do bucket

**Description:** Encapsula todo acesso ao object storage em um módulo próprio (responsabilidade única), com os dois clientes do TD-01 e o bootstrap idempotente do bucket, para que vídeos e worker nunca falem com o SDK diretamente.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.constants.ts` — providers `S3_INTERNAL_CLIENT` (`endpoint: S3_ENDPOINT`) e `S3_PUBLIC_CLIENT` (`endpoint: S3_PUBLIC_ENDPOINT`, usado só para assinar), ambos com `forcePathStyle`, credenciais do namespace `storage` e `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-01`; `library-refs.md` → `@aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` — `createMultipartUpload`, `presignUploadPart` (cliente público), `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `getObjectStream(key, range?)`, `presignInternalGetObject` (cliente interno), `putObject`, `deleteObject` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`; `library-refs.md` → `@aws-sdk/s3-request-presigner`)
3. Criar `src/storage/storage-bootstrap.service.ts` — `OnApplicationBootstrap`: `HeadBucket` → `CreateBucket` se ausente, `PutBucketCors` (origens `S3_CORS_ALLOWED_ORIGINS`, métodos `PUT`/`GET`/`HEAD`, `ExposeHeaders: ['ETag']`) e `PutBucketLifecycleConfiguration` com `AbortIncompleteMultipartUpload` (`DaysAfterInitiation: 1`, prefixo `videos/`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-07` revisão ICC-1, `phase-03-videos/TD-14`)
4. Exportar `StorageService` no `StorageModule` (consumido por `VideosModule` e pelo worker)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — multipart via URL pré-assinada + `fetch`, `ListParts`, complete, abort, `GetObject` com Range, put/delete | `src/storage/storage.service.integration-spec.ts` |
| `StorageBootstrapService` | Integration: MinIO real — bucket criado, CORS e lifecycle legíveis, execução repetida sem erro | `src/storage/storage-bootstrap.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo (DI) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO no Compose, libs AWS e namespace `storage`

**Acceptance criteria:**

- `PUT` simples (sem headers extras) numa URL de `UploadPart` pré-assinada retorna `200` com header `ETag`
- Completar um multipart de 2 partes (5 MiB + 1 KiB) produz um objeto cujo `ContentLength` é a soma das partes
- `GetObject` com `Range: bytes=0-9` devolve exatamente os 10 primeiros bytes e `ContentRange: bytes 0-9/{size}`
- Após `AbortMultipartUpload`, `ListParts` do mesmo `UploadId` falha (`NoSuchUpload`)
- Rodar o bootstrap duas vezes não gera erro e deixa a regra `AbortIncompleteMultipartUpload` e a regra CORS com `ETag` exposto configuradas no bucket

---

### SI-03.3 — QueueModule: conexão BullMQ e constantes da fila de vídeo

**Description:** Configura a conexão raiz do BullMQ com o Redis em um módulo de infraestrutura compartilhado por API e worker, e fixa o nome da fila/job de `### Events/Messages`.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host, port } }) })` (per `phase-03-videos/TD-04`; `library-refs.md` → `@nestjs/bullmq`)
2. Criar `src/videos/videos.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_PROCESS_JOB = 'video.process'`, `VIDEO_PROCESS_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 100 } as const` (per `phase-03-videos/TD-10`; rule `nestjs-common-conventions.md` → constants)
3. Importar `QueueModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration: Redis real — fila registrada sobre a conexão raiz responde `PING` | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 — Redis no Compose e namespace `queue`

**Acceptance criteria:**

- A aplicação sobe com `REDIS_HOST=redis` e o cliente da fila `video-processing` responde `PONG` ao `PING`
- Com o serviço `redis` parado, a fila não consegue conectar (o erro de conexão aparece no log; nenhuma conexão para `localhost` é tentada)

---

### SI-03.4 — Entidade Video e migration da tabela `videos`

**Description:** Cria a persistência do vídeo ligada ao canal, exatamente como em `### Data Model → Video`, com migration gerada pelo CLI e os helpers de teste atualizados para a nova FK.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos de `### Data Model → Video` (enum `VideoStatus`, `size_bytes` bigint com transformer para `number`, `metadata` jsonb, `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, índice em `channel_id`, `slug` unique) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
2. Atualizar `src/channels/entities/channel.entity.ts` — `@OneToMany(() => Video, (video) => video.channel) videos` (rule `nestjs-entities.md` → ambos os lados)
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule` (rule `nestjs-modules.md`)
4. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate` (enum `videos_status_enum`, tabela, unique `slug`, índice e FK `channel_id`) e aplicar com `migration:run` (rule `typeorm-migrations.md`)
5. Atualizar `src/test/create-test-data-source.ts` (`cleanAllTables` apaga `videos` antes de `channels`) e `src/database/migrations.integration-spec.ts` (importa a nova migration, espera 3 migrations e a tabela `videos`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `draft`, unique `slug`, `channel_id` obrigatório, `size_bytes` de 10 GiB volta como `number`, `metadata` jsonb | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica 3 migrations e reverte a última removendo `videos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — ambiente atualizado (a entidade não depende de storage/fila)

**Acceptance criteria:**

- `npm run migration:run` num banco com as migrations da Fase 02 cria a tabela `videos` e o tipo `videos_status_enum`; `migration:revert` remove ambos
- Inserir um vídeo sem `status` grava `draft`
- Inserir dois vídeos com o mesmo `slug` viola a constraint única (`23505`)
- Inserir um vídeo com `channel_id` inexistente viola a FK
- Um vídeo salvo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`

---

### SI-03.5 — VideosService: rascunho com URL única e transições de status

**Description:** Concentra as regras de persistência do vídeo — geração do slug único com retry em colisão, buscas por dono e por slug pronto, e as transições `draft → processing → ready | failed` — no serviço dono da entidade.

**Technical actions:**

1. Criar `src/videos/slug.util.ts` — `generateVideoSlug()`: 11 caracteres de `[0-9A-Za-z]` via `crypto.randomInt` (sem dependência) (per `phase-03-videos/TD-11`)
2. Criar `src/videos/videos.service.ts` — `createDraft(input)` insere o vídeo `draft`; em `23505` na coluna `slug` gera novo slug e tenta de novo (até 5 tentativas; insert único fora de transação, sem SAVEPOINT) (per `phase-03-videos/TD-11`, padrão de retry da Fase 02)
3. Em `VideosService`: `findOwnedById(id, userId)` (join com `channel.user_id`; inexistente ou de outro dono → `VideoNotFoundException`), `findReadyBySlug(slug)` (status ≠ `ready` → `VideoNotFoundException`), `markProcessing(id, sizeBytes)`, `markReady(id, { durationSeconds, metadata, thumbnailKey })`, `markFailed(id, message)`, `remove(id)` (per `phase-03-videos/TD-10`)
4. Adicionar em `src/common/exceptions/domain.exception.ts` as exceções de `### Error Catalog` (`VideoNotFoundException`, `VideoNotUploadableException`, `VideoFileTooLargeException`, `InvalidPartRangeException`, `UploadIncompleteException`, `RangeNotSatisfiableException`, `ChannelNotFoundException`)
5. Exportar `VideosService` em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: tamanho 11, alfabeto base62, valores distintos | `src/videos/slug.util.spec.ts` |
| `VideosService` | Unit: retry em colisão de slug, esgotamento de tentativas, erro não-slug propaga (repo mock) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB real — rascunho criado, lookup de outro dono falha, `findReadyBySlug` ignora não-`ready`, `markFailed` grava `processing_error` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — entidade `Video`

**Acceptance criteria:**

- `createDraft` grava um vídeo `draft` com `slug` de 11 caracteres base62
- Quando o primeiro slug sorteado já existe, `createDraft` grava o vídeo com outro slug (sem erro para o chamador)
- `findOwnedById` com o `id` de um vídeo de outro canal lança `VIDEO_NOT_FOUND`
- `findReadyBySlug` de um vídeo em `processing` lança `VIDEO_NOT_FOUND`
- `markFailed(id, 'msg')` deixa `status = failed` e `processing_error = 'msg'`; `markReady` limpa `processing_error`

---

### SI-03.6 — Início do upload e URLs de partes (POST /videos, GET /videos/:id, GET /videos/:id/upload/parts)

**Description:** Expõe a primeira metade do handshake de upload direto ao storage: valida a política, pré-cadastra o rascunho com o multipart aberto e emite URLs de partes sob demanda — nenhum byte de vídeo passa pela API.

**Technical actions:**

1. Criar DTOs em `src/videos/dto/` — `create-video.dto.ts` (`filename`, `content_type`, `size`, `title?`), `upload-parts-query.dto.ts` (`from`, `to` com `@Type(() => Number)`), e de resposta `video-response.dto.ts`, `video-upload-session.dto.ts`, `upload-parts.dto.ts` com `@ApiProperty` (per `### API Contracts`; rule `nestjs-dtos.md`)
2. Adicionar `ChannelsService.findByUserId(userId)` (retorna `Channel | null`) — a busca do canal fica no módulo dono (princípio de responsabilidade única do CLAUDE.md)
3. Criar `src/videos/video-uploads.service.ts` — `initiate(userId, dto)`: `size > VIDEO_MAX_UPLOAD_BYTES` → `VideoFileTooLargeException`; canal ausente → `ChannelNotFoundException`; gera `id`, `storage_key = videos/{id}/original`, `CreateMultipartUpload`, `VideosService.createDraft`; se o insert falhar, `AbortMultipartUpload` (compensação) e relança; devolve `part_size`/`part_count = ceil(size / part_size)`/`expires_in_seconds` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08` + revisão AMB-2)
4. Em `VideoUploadsService`: `getPartUrls(userId, id, from, to)` — dono via `findOwnedById`, status ≠ `draft` → `VideoNotUploadableException`, intervalo inválido / lote > 100 / `to > part_count` → `InvalidPartRangeException`; `presignUploadPart` por parte + `listParts` para `uploaded_parts` (per `phase-03-videos/TD-08`)
5. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()` (resolução de DG-1); `POST /videos` (201), `GET /videos/:id` e `GET /videos/:id/upload/parts` autenticados (`@ApiBearerAuth('access-token')`, `@CurrentUser()`), Swagger por status de `### API Contracts` com `ApiErrorEnvelope`; registrar controller + `VideoUploadsService` + imports (`StorageModule`, `ChannelsModule`) no `VideosModule` (rule `nestjs-controllers.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService` | Unit: limite de tamanho, cálculo de `part_count`, erros de intervalo, compensação com abort (mocks) | `src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService` | Integration: DB + MinIO reais — rascunho + multipart abertos; URLs de parte aceitam `PUT`; `uploaded_parts` reflete a parte enviada | `src/videos/video-uploads.service.integration-spec.ts` |
| `VideosController` + DTOs | E2E: `POST /videos`, `GET /videos/:id`, `GET /videos/:id/upload/parts` (status, validação, auth, posse, throttle) | `test/videos-upload.e2e-spec.ts` |
| `VideosModule` | Unit: compilação do módulo (DI) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 (storage), SI-03.5 (`VideosService` e exceções)

**Acceptance criteria:**

- `POST /videos` autenticado com `{ filename: "aula.mp4", content_type: "video/mp4", size: 10737418240 }` retorna `201` com `video.status = "draft"`, `video.title = "aula"` e `upload.part_count = 160`
- `POST /videos` com `size: 10737418241` retorna `400` com `error: "VIDEO_FILE_TOO_LARGE"`; com `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- `GET /videos/:id` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id/upload/parts?from=1&to=2` retorna `200` com 2 URLs; um `PUT` de 5 MiB na primeira devolve `ETag`, e a chamada seguinte lista essa parte em `uploaded_parts`
- `GET /videos/:id/upload/parts?from=3&to=1` retorna `400` com `error: "INVALID_PART_RANGE"`
- 15 chamadas seguidas a `GET /videos/:id/upload/parts` dentro de 1 minuto não retornam `429`

---

### SI-03.7 — Conclusão e cancelamento do upload com enfileiramento do processamento

**Description:** Fecha o handshake: completa o multipart, move o vídeo para `processing` e publica `video.process` na fila; ou cancela o upload liberando as partes no storage.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { part_number, etag }[]` com `@ValidateNested` + `@Type`, `@ArrayMinSize(1)`, `@ArrayMaxSize(10000)` (per `### API Contracts → POST /videos/:id/upload/complete`)
2. Criar `src/videos/video-processing.producer.ts` — `@InjectQueue(VIDEO_PROCESSING_QUEUE)`; `enqueue(videoId)` faz `queue.add(VIDEO_PROCESS_JOB, { videoId }, { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: videoId })`; registrar `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` no `VideosModule` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-09`, `### Events/Messages`)
3. Em `VideoUploadsService.complete(userId, id, dto)`: dono + `draft`; partes ≠ `part_count`, repetidas ou fora do intervalo → `UploadIncompleteException`; `CompleteMultipartUpload` (rejeição `InvalidPart`/`InvalidPartOrder`/`NoSuchUpload` do storage → `UploadIncompleteException`); `HeadObject` — `ContentLength > VIDEO_MAX_UPLOAD_BYTES` → `deleteObject` + `markFailed` + `VideoFileTooLargeException`; senão `markProcessing(id, ContentLength)` (zera `upload_id`) e `producer.enqueue(id)` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
4. Em `VideoUploadsService.cancel(userId, id)`: dono + `draft`; `AbortMultipartUpload` e `VideosService.remove(id)` (per `phase-03-videos/TD-14`)
5. Adicionar ao `VideosController` `POST /videos/:id/upload/complete` (`@HttpCode(202)`) e `DELETE /videos/:id/upload` (`@HttpCode(204)`), com Swagger por status

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService` (complete/cancel) | Unit: validação das partes, mapeamento de rejeição do storage, objeto acima do limite, cancelamento fora de `draft` | `src/videos/video-uploads.service.spec.ts` |
| `VideoProcessingProducer` | Integration: Redis real (prefixo de fila isolado) — job com `jobId = videoId`, `attempts: 3`, backoff exponencial; enqueue repetido não duplica | `src/videos/video-processing.producer.integration-spec.ts` |
| `VideosController` (complete/cancel) | E2E: complete `202` → `processing`; complete repetido `409`; partes faltando `400`; cancel `204` e `GET` posterior `404` | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.3 (fila), SI-03.6 (início do upload)

**Acceptance criteria:**

- Após enviar todas as partes, `POST /videos/:id/upload/complete` com as ETags retorna `202` com `status: "processing"` e `size_bytes` igual ao tamanho real do objeto
- O complete deixa na fila `video-processing` um job `video.process` com `jobId` igual ao `id` do vídeo e payload `{ videoId }`
- Um segundo `POST /videos/:id/upload/complete` no mesmo vídeo retorna `409` com `error: "VIDEO_NOT_UPLOADABLE"`
- `POST /videos/:id/upload/complete` com menos partes que `part_count` retorna `400` com `error: "UPLOAD_INCOMPLETE"` e o vídeo continua `draft`
- `DELETE /videos/:id/upload` de um rascunho retorna `204`; em seguida `GET /videos/:id` retorna `404` e o `UploadId` não existe mais no storage
- `DELETE /videos/:id/upload` de um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_UPLOADABLE"`

---

### SI-03.8 — Runtime do worker de vídeo e integração com FFmpeg

**Description:** Cria o segundo entrypoint do mesmo codebase (container `video-worker`, sem servidor HTTP) e o serviço que executa `ffprobe`/`ffmpeg` sobre uma URL pré-assinada, com mídia de teste gerada na hora.

**Technical actions:**

1. Extrair do `AppModule` o `ConfigModule.forRoot(...)` para `src/config/app-config.module.ts` e o `TypeOrmModule.forRootAsync(...)` para `src/database/database.module.ts` — mesma configuração reutilizada por API e worker, sem duplicar (convenções herdadas de config/TypeORM da Fase 01)
2. Criar `src/worker.module.ts` (importa `AppConfigModule`, `DatabaseModule`, `QueueModule`) e `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`); scripts `start:worker` (dev, `ts-node` com watch) e `start:worker:prod` (`node dist/worker`) no `package.json` (per `phase-03-videos/TD-05`)
3. Adicionar ao `compose.yaml` o serviço `video-worker` — mesma imagem `Dockerfile.dev`, mesmo volume, `command: npm run start:worker`, `restart: unless-stopped`, depende de `db`/`redis`/`minio` saudáveis (per `phase-03-videos/TD-05`)
4. Criar `src/video-processing/ffmpeg.service.ts` — `probe(url)` executa `ffprobe -v error -print_format json -show_format -show_streams` via `child_process.spawn` e devolve `{ durationSeconds, metadata, hasVideoStream }`; `extractThumbnail(url, atSeconds)` executa `ffmpeg -ss … -i … -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1` e devolve o JPEG (`Buffer`); código de saída ≠ 0 → erro com o `stderr` (per `phase-03-videos/TD-06`)
5. Criar `src/test/video-fixture.ts` — gera um MP4 curto com `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=25` em diretório temporário (per `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration: FFmpeg + MinIO reais — probe por URL pré-assinada (duração ≈ 2s, 320×240, codec), thumbnail JPEG válido, probe de arquivo não-vídeo falha | `src/video-processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (FFmpeg na imagem), SI-03.2 (URL interna pré-assinada), SI-03.3 (`QueueModule`)

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker`, que permanece em execução sem abrir porta HTTP
- `probe` sobre a URL pré-assinada de um MP4 de 2s (320×240) retorna `durationSeconds` entre 1,9 e 2,1, `metadata.width = 320`, `metadata.height = 240` e `hasVideoStream = true`
- `extractThumbnail` retorna bytes que começam com a assinatura JPEG `FF D8`
- `probe` sobre bytes aleatórios lança erro contendo a saída de `ffprobe`
- O `AppModule` continua subindo com a configuração e o banco vindos dos módulos extraídos (`GET /` retorna `200`)

---

### SI-03.9 — Processamento no worker: metadados, thumbnail e ciclo de status

**Description:** Implementa o consumidor de `video.process`: extrai duração/metadados, gera e grava a thumbnail e leva o vídeo a `ready`, ou a `failed` com a mensagem de erro após a última tentativa.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` — `process(videoId)` segue `### Events/Messages → Processing` passos 1–5 (status ≠ `processing` → retorna sem efeito; `presignInternalGetObject`; `probe`; sem stream de vídeo → `UnrecoverableError`; thumbnail em `t = duration × 0.1` (0 se < 1s); `putObject(videos/{id}/thumbnail.jpg)`; `VideosService.markReady`) e `markFailed(videoId, message)` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-10`)
2. Criar `src/video-processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` delega a `VideoProcessingService.process(job.data.videoId)`; `@OnWorkerEvent('failed')` chama `markFailed` quando o erro é `UnrecoverableError` ou `job.attemptsMade ≥ job.opts.attempts` (catch-and-log permitido em handler de background — rule `nestjs-services.md`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-10`; `library-refs.md` → `bullmq`)
3. Criar `src/video-processing/video-processing.module.ts` — imports `VideosModule`, `StorageModule`, `UsersModule` (metadados `User`/`Channel` exigidos pela relação `Video → Channel → User`), `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; providers `FfmpegService`, `VideoProcessingService`, `VideoProcessor`
4. Importar `VideoProcessingModule` **apenas** no `WorkerModule` — a API continua só produtora (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: ignora vídeo fora de `processing`, sem stream de vídeo → `UnrecoverableError`, caminho feliz chama `markReady` com `thumbnail_key` (mocks) | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessor` | Unit: `failed` na última tentativa marca `failed`; tentativa intermediária não marca; `UnrecoverableError` marca na primeira | `src/video-processing/video.processor.spec.ts` |
| `VideoProcessingService` | Integration: DB + MinIO + FFmpeg reais — vídeo vai a `ready` com duração, metadados e thumbnail no storage; arquivo inválido falha | `src/video-processing/video-processing.service.integration-spec.ts` |
| `WorkerModule` | Integration: contexto do worker sobe e resolve `VideoProcessor` | `src/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.5 (`VideosService`), SI-03.7 (job publicado), SI-03.8 (worker runtime e `FfmpegService`)

**Acceptance criteria:**

- Um vídeo `processing` com um MP4 válido no storage termina `ready` com `duration_seconds` ≈ 2, `metadata.width = 320`, `thumbnail_key = videos/{id}/thumbnail.jpg` e o objeto JPEG presente no bucket
- Um vídeo `processing` cujo objeto não é vídeo termina `failed` com `processing_error` preenchido, sem novas tentativas
- Uma falha transitória na 1ª tentativa deixa o vídeo em `processing` (o job é re-agendado); na 3ª falha o vídeo vira `failed`
- Processar de novo um vídeo já `ready` não altera seus dados

---

### SI-03.10 — Streaming com Range, download e thumbnail

**Description:** Entrega vídeos `ready` a qualquer espectador por stream progressivo (`206 Partial Content`), download como anexo e thumbnail, sempre por stream do storage sem bufferizar o arquivo.

**Technical actions:**

1. Criar `src/videos/range.util.ts` — `parseRange(header, size)`: aceita `bytes=a-b`, `bytes=a-`, `bytes=-n` (um intervalo), limita `end` a `size - 1`; múltiplos intervalos, sintaxe inválida ou `start ≥ size` → `RangeNotSatisfiableException` (per `phase-03-videos/TD-12`)
2. Estender `DomainException` com `headers?: Record<string, string>` e fazer o `DomainExceptionFilter` aplicá-los; `RangeNotSatisfiableException(size)` envia `Content-Range: bytes */{size}` (per `### Error Catalog`)
3. Criar `src/videos/video-delivery.service.ts` — `openMedia(slug, rangeHeader?)` (`findReadyBySlug` → `headObject` → `parseRange` → `getObjectStream`) devolvendo `{ statusCode: 200 | 206, headers, stream }`; `openThumbnail(slug)`; nome do anexo sanitizado a partir de `original_filename` (per `phase-03-videos/TD-12` + revisão AMB-1)
4. Adicionar ao `VideosController` `GET /videos/:slug/stream`, `GET /videos/:slug/download` (`Content-Disposition: attachment`) e `GET /videos/:slug/thumbnail` com `@Public()` (sem `@ApiBearerAuth`), validação do slug `^[0-9A-Za-z]{11}$`, aplicando status/headers e fazendo `pipeline(stream, res)`; o stream do storage é destruído se o cliente desconectar (`library-refs.md` → leitura única do body)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseRange` | Unit: formas fechada/aberta/sufixo, clamp no fim, múltiplos intervalos, inválido, além do tamanho | `src/videos/range.util.spec.ts` |
| `DomainExceptionFilter` | Unit: aplica `headers` da exceção na resposta | `src/common/filters/domain-exception.filter.spec.ts` |
| `VideosController` (entrega) | E2E: vídeo `ready` semeado no DB + objeto no MinIO — `206` com bytes exatos, `200` sem Range, `416` com `Content-Range`, `404` para `draft`, download com `Content-Disposition`, thumbnail `image/jpeg`, acesso anônimo | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.2 (leitura por Range), SI-03.5 (`findReadyBySlug`), SI-03.6 (`VideosController`)

**Acceptance criteria:**

- `GET /videos/:slug/stream` sem token e com `Range: bytes=0-1023` retorna `206`, `Content-Range: bytes 0-1023/{size}`, `Accept-Ranges: bytes` e exatamente 1024 bytes iguais ao início do arquivo
- `GET /videos/:slug/stream` com `Range: bytes=-100` retorna `206` com os 100 últimos bytes
- `GET /videos/:slug/stream` sem `Range` retorna `200` com `Content-Length = size_bytes` e o arquivo inteiro
- `GET /videos/:slug/stream` com `Range: bytes={size}-` retorna `416` com `Content-Range: bytes */{size}` e `error: "RANGE_NOT_SATISFIABLE"`
- `GET /videos/:slug/download` retorna `200` com `Content-Disposition: attachment; filename="{original_filename}"`
- `GET /videos/:slug/thumbnail` de um vídeo `ready` retorna `200` `image/jpeg`; qualquer rota de entrega de um vídeo `draft` ou de slug inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.11 — Pipeline ponta a ponta e contrato OpenAPI

**Description:** Prova o fluxo completo da fase sobre a infra real — upload multipart → complete → fila → worker → `ready` → stream — e o caminho de erro, e publica os novos endpoints no `openapi.json` versionado.

**Technical actions:**

1. Criar `test/video-pipeline.e2e-spec.ts` — sobe `AppModule` (HTTP) e o contexto do `WorkerModule` no mesmo processo; envia um MP4 gerado (`src/test/video-fixture.ts`) pelas URLs de parte, chama o complete, aguarda (polling de `GET /videos/:id`, timeout) o status `ready` e consome `/stream` com Range e `/thumbnail` (per `phase-03-videos/TD-13`)
2. No mesmo spec, caminho de falha: enviar bytes que não são vídeo com `content_type: video/mp4` → complete → status final `failed` com `processing_error` preenchido (per `phase-03-videos/TD-10`)
3. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` e estender `src/openapi-export.integration-spec.ts` para exigir os paths `/videos`, `/videos/{id}/upload/parts`, `/videos/{id}/upload/complete`, `/videos/{slug}/stream` (per `openapi-docs-nestjs/TD-02`)
4. Sincronizar a cópia do contrato no frontend com `scripts/sync-openapi.sh` e regenerar os tipos derivados, sem tocar em UI (per `next-frontend-openapi-typing/TD-02`, `next-frontend-openapi-typing/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline upload → fila → worker → streaming | E2E: infra real (Postgres, MinIO, Redis, FFmpeg) — sucesso e falha | `test/video-pipeline.e2e-spec.ts` |
| Export do OpenAPI | Integration: documento contém os paths de vídeo | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.7, SI-03.9, SI-03.10

**Acceptance criteria:**

- Um MP4 enviado por URLs pré-assinadas e completado chega a `status: "ready"` com `duration_seconds`, `metadata` e `thumbnail_url` preenchidos, sem nenhuma chamada manual ao worker
- Logo após o complete, `GET /videos/:slug/stream` do mesmo vídeo retorna `404` (ainda não `ready`); depois do `ready` retorna `206` para `Range: bytes=0-99`
- Bytes inválidos enviados como `video/mp4` levam o vídeo a `status: "failed"` com `processing_error` não vazio
- `nestjs-project/openapi.json` e `next-frontend/openapi.json` são idênticos e contêm `/videos/{slug}/stream`

---

### SI-03.12 — Documentação de IA e do projeto para a fase de vídeos

**Description:** Deixa `CLAUDE.md` (raiz e `nestjs-project/`), README e diagrama de arquitetura coerentes com o código entregue — módulo de vídeos, endpoints, fila/worker e storage.

**Technical actions:**

1. Atualizar `CLAUDE.md` (raiz) — Message Queue `TBD` → Redis + BullMQ; seção de vídeos com o fluxo upload direto → fila → worker → streaming e os princípios de storage/fila (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-12`)
2. Atualizar `nestjs-project/CLAUDE.md` — serviços `redis`, `minio`, `video-worker` com checks de prontidão, comandos do worker, seção "Videos" (módulos `storage`/`queue`/`videos`/`video-processing`, endpoints, chaves de config, convenções de teste com MinIO/Redis/FFmpeg reais)
3. Atualizar `README.md` (raiz) — serviços/portas novos, endpoints de vídeo, status da Fase 03 e estrutura de pastas; atualizar `docs/diagrams/software-arch.mermaid` (fila = Redis/BullMQ; frontend envia partes direto ao storage e faz streaming via API)
4. Atualizar `nestjs-project/api.http` com o fluxo de upload/streaming de exemplo

**Tests:** _(empty — documentação; verificada pela coerência com o código no fechamento da fase)_

**Dependencies:** SI-03.11

**Acceptance criteria:**

- Todo arquivo, comando, endpoint e chave de configuração citado nos `CLAUDE.md` existe no código entregue
- O `CLAUDE.md` raiz não cita mais a fila como `TBD`
- Seguir o README do zero (`docker compose up -d`, `npm install`, `migration:run`) deixa API, `video-worker`, `minio` e `redis` em execução

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Um vídeo pertence a um canal (`Channel` 1:N `Video`); o dono é o usuário do canal (relação 1:1 herdada da Fase 02).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK — gerado pelo serviço (`randomUUID()`) antes do insert, porque a chave de storage deriva dele (per `phase-03-videos/TD-02`) |
| channel_id | uuid | not null, FK → `channels.id` |
| slug | varchar(11) | unique, not null — 11 caracteres base62 (per `phase-03-videos/TD-11`) |
| title | varchar(100) | not null — default: `original_filename` sem extensão, truncado em 100 (per `phase-03-videos/TD-08` revisão AMB-2) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-10`) |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — `video/*` |
| size_bytes | bigint | not null — mapeado para `number` via transformer (10 GiB < 2^53) |
| storage_key | varchar(255) | not null — `videos/{id}/original` (per `phase-03-videos/TD-02`) |
| upload_id | varchar(1024) | nullable — `UploadId` do multipart; zerado (`null`) após complete/abort (per `phase-03-videos/TD-07`) |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg`, preenchido pelo worker (per `phase-03-videos/TD-06`) |
| duration_seconds | double precision | nullable — `format.duration` do ffprobe |
| metadata | jsonb | nullable — `{ width, height, videoCodec, audioCodec, formatName, bitRate, frameRate }` extraído do ffprobe (per `phase-03-videos/TD-06`) |
| processing_error | text | nullable — mensagem da última falha terminal (per `phase-03-videos/TD-10`) |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), auto-update |

**Relations:** `Video` many-to-one `Channel` (`video.channel`, join column `channel_id`); `Channel` one-to-many `Video` (`channel.videos`) — os dois lados declarados (rule `nestjs-entities.md`).
**Indexes:** unique em `slug`; índice em `channel_id`.
**Status lifecycle (per `phase-03-videos/TD-10`):** `draft` (criado em `POST /videos`) → `processing` (em `POST /videos/:id/upload/complete`) → `ready` (worker concluiu) | `failed` (última tentativa do job falhou, ou erro permanente). Só `ready` é entregue por stream/download/thumbnail.

#### Storage object keys (per `phase-03-videos/TD-02`)

| Object | Key | Written by |
|--------|-----|-----------|
| Arquivo original | `videos/{videoId}/original` | Cliente via URLs pré-assinadas de `UploadPart` (multipart) |
| Thumbnail | `videos/{videoId}/thumbnail.jpg` | Worker (`PutObject`, `image/jpeg`) |

Bucket único e privado `S3_BUCKET` (default `streamtube`), com bootstrap idempotente na inicialização: cria o bucket se não existir, aplica CORS (origens de `S3_CORS_ALLOWED_ORIGINS`, métodos `PUT`/`GET`/`HEAD`, `ExposeHeaders: ['ETag']`) e a regra de lifecycle `AbortIncompleteMultipartUpload` (`DaysAfterInitiation: 1`, prefixo `videos/`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-14`).

#### Configuration (per `phase-03-videos/TD-15`)

| Namespace (`registerAs`) | File | Env key | Default (Compose) | Validation (Joi) |
|---|---|---|---|---|
| `storage` | `src/config/storage.config.ts` | `S3_ENDPOINT` | `http://minio:9000` | uri |
| | | `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | uri |
| | | `S3_REGION` | `us-east-1` | string |
| | | `S3_ACCESS_KEY_ID` | — | string, required |
| | | `S3_SECRET_ACCESS_KEY` | — | string, required |
| | | `S3_BUCKET` | `streamtube` | string |
| | | `S3_FORCE_PATH_STYLE` | `true` | `'true'`/`'false'` |
| | | `S3_CORS_ALLOWED_ORIGINS` | `http://localhost:3001` | string (lista separada por vírgula) |
| `queue` | `src/config/queue.config.ts` | `REDIS_HOST` | `redis` | string |
| | | `REDIS_PORT` | `6379` | port |
| `video` | `src/config/video.config.ts` | `VIDEO_MAX_UPLOAD_BYTES` | `10737418240` (10 GiB) | integer ≥ 1 |
| | | `VIDEO_UPLOAD_PART_SIZE_BYTES` | `67108864` (64 MiB) | integer ≥ 5242880 (5 MiB, mínimo S3) |
| | | `VIDEO_PRESIGN_EXPIRES_SECONDS` | `3600` | integer ≥ 60 |

`S3_CORS_ALLOWED_ORIGINS` concretiza a revisão ICC-1 de `phase-03-videos/TD-07` (CORS restrito à origem do frontend, `ETag` exposto).

### API Contracts

Todos os endpoints vivem em `VideosController` (`@Controller('videos')`, `@ApiTags('videos')`, `@SkipThrottle()` — resolução de DG-1). Rotas do dono usam o `id` (uuid, `ParseUUIDPipe`); rotas públicas de entrega usam o `slug` (11 chars base62, validado por regex) — os dois formatos não colidem (uuid contém hífens). Formato de erro herdado: `{ statusCode, error, message }` (per `phase-02-auth/TD-07`).

**`VideoResponseDto`** (corpo de resposta compartilhado):
- id: string (uuid)
- slug: string — 11 chars base62
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- original_filename: string
- content_type: string
- size_bytes: number
- duration_seconds: number | null
- metadata: object | null — `{ width, height, videoCodec, audioCodec, formatName, bitRate, frameRate }`
- processing_error: string | null
- stream_url: string — `/videos/{slug}/stream`
- download_url: string — `/videos/{slug}/download`
- thumbnail_url: string | null — `/videos/{slug}/thumbnail` quando `thumbnail_key` existe
- created_at: string (ISO 8601)
- updated_at: string (ISO 8601)

---

#### POST /videos (SI-03.6)

Inicia o upload: valida a política, cria o multipart no storage e pré-cadastra o vídeo como `draft` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- filename: string, required — 1–255 caracteres
- content_type: string, required — casa `^video\/[\w.+-]+$`
- size: number, required — inteiro ≥ 1; ≤ `VIDEO_MAX_UPLOAD_BYTES` (checado no serviço → `VIDEO_FILE_TOO_LARGE`)
- title: string, optional — 1–100 caracteres; ausente → nome do arquivo sem extensão

**Response 201:**
- video: `VideoResponseDto` (status `draft`)
- upload: `{ part_size: number, part_count: number, expires_in_seconds: number }` — `part_count = ceil(size / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido (campos ausentes, `content_type` fora de `video/*`, `size` não inteiro)
- 400 VIDEO_FILE_TOO_LARGE: `size` > `VIDEO_MAX_UPLOAD_BYTES`
- 401 (guard JWT global): token ausente ou inválido
- 404 CHANNEL_NOT_FOUND: usuário autenticado sem canal

---

#### GET /videos/:id (SI-03.6)

Retorna o vídeo do dono em qualquer status — é como o dono acompanha `draft → processing → ready | failed`.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:** `VideoResponseDto`

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é uuid
- 401: token ausente ou inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal (não revela existência)

---

#### GET /videos/:id/upload/parts (SI-03.6)

Emite URLs pré-assinadas de `UploadPart` para um intervalo de partes e informa as partes já recebidas (retomada) (per `phase-03-videos/TD-08`).

**Request headers:**
- Authorization: Bearer {access_token}

**Request query parameters:**
- from: number, required — inteiro ≥ 1
- to: number, required — inteiro ≥ `from`; `to - from + 1 ≤ 100`; `to ≤ part_count`

**Response 200:**
- part_size: number
- part_count: number
- expires_in_seconds: number
- parts: `[{ part_number: number, url: string }]` — URL assinada para `S3_PUBLIC_ENDPOINT`; o cliente faz `PUT` do bloco e lê o header `ETag`
- uploaded_parts: `[{ part_number: number, etag: string, size: number }]` — via `ListParts`

**Error responses:**
- 400 VALIDATION_ERROR: `from`/`to` ausentes ou não inteiros
- 400 INVALID_PART_RANGE: `to < from`, lote > 100 ou `to > part_count`
- 401: token ausente ou inválido
- 404 VIDEO_NOT_FOUND: inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: status ≠ `draft`

---

#### POST /videos/:id/upload/complete (SI-03.7)

Fecha o multipart com as ETags, muda o status para `processing` e enfileira o processamento (per `phase-03-videos/TD-09`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array, required — 1–10000 itens `{ part_number: number (inteiro ≥ 1), etag: string (não vazio) }`

**Response 202:** `VideoResponseDto` (status `processing`, `size_bytes` atualizado com o `ContentLength` real do objeto)

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido
- 400 UPLOAD_INCOMPLETE: número de partes ≠ `part_count`, `part_number` repetidos/fora de 1..`part_count`, ou o storage rejeitou as partes/ETags
- 400 VIDEO_FILE_TOO_LARGE: o objeto montado excede `VIDEO_MAX_UPLOAD_BYTES` (objeto removido, vídeo marcado `failed`)
- 401: token ausente ou inválido
- 404 VIDEO_NOT_FOUND: inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: status ≠ `draft`

---

#### DELETE /videos/:id/upload (SI-03.7)

Cancela um upload em andamento: aborta o multipart e remove o rascunho (per `phase-03-videos/TD-14`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é uuid
- 401: token ausente ou inválido
- 404 VIDEO_NOT_FOUND: inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: status ≠ `draft`

---

#### GET /videos/:slug/stream (SI-03.10)

Streaming progressivo com HTTP Range (per `phase-03-videos/TD-12`). Público; contrato transparente a headers para o futuro BFF (revisão ICC-2).

**Request headers:**
- Range: `bytes=start-end` | `bytes=start-` | `bytes=-suffix`, optional (um único intervalo)

**Response 206:** corpo = bytes do intervalo; headers `Content-Range: bytes start-end/size`, `Content-Length`, `Content-Type` (= `content_type` do vídeo), `Accept-Ranges: bytes`
**Response 200:** sem `Range` — arquivo inteiro em stream; headers `Content-Length`, `Content-Type`, `Accept-Ranges: bytes`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo não `ready`
- 416 RANGE_NOT_SATISFIABLE: intervalo inválido/fora do arquivo; header `Content-Range: bytes */size`

---

#### GET /videos/:slug/download (SI-03.10)

Download do arquivo original para qualquer espectador (revisão AMB-1 de `phase-03-videos/TD-12`). Mesmo tratamento de Range do stream (downloads retomáveis).

**Response 200 / 206:** como `/stream`, mais `Content-Disposition: attachment; filename="{original_filename sanitizado}"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo não `ready`
- 416 RANGE_NOT_SATISFIABLE: intervalo inválido; header `Content-Range: bytes */size`

---

#### GET /videos/:slug/thumbnail (SI-03.10)

**Response 200:** `image/jpeg` em stream; `Cache-Control: public, max-age=300`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente, vídeo não `ready` ou sem thumbnail

---

#### Validation Rules — Upload handshake

- `filename`: required, string, 1–255
- `content_type`: required, `^video\/[\w.+-]+$`
- `size`: required, inteiro ≥ 1 (teto de `VIDEO_MAX_UPLOAD_BYTES` no serviço, porque depende de configuração)
- `title`: optional, string, 1–100
- `from` / `to`: required, inteiros ≥ 1 (`@Type(() => Number)`)
- `parts[]`: 1–10000 itens; `part_number` inteiro ≥ 1; `etag` string não vazia
- `:id`: uuid (`ParseUUIDPipe`); `:slug`: `^[0-9A-Za-z]{11}$`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (não dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | ✗ (401) | ✓ (cria no próprio canal) | ✓ |
| GET /videos/:id | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug/stream | ✓ (`ready`) | ✓ (`ready`) | ✓ (`ready`) |
| GET /videos/:slug/download | ✓ (`ready`) | ✓ (`ready`) | ✓ (`ready`) |
| GET /videos/:slug/thumbnail | ✓ (`ready`) | ✓ (`ready`) | ✓ (`ready`) |

"Owner" = o `sub` do JWT é o `user_id` do canal do vídeo. Rotas públicas usam `@Public()` (rule `nestjs-controllers.md`); visibilidade público/unlisted é Fase 04/05 — nesta fase todo vídeo `ready` é entregue (revisão AMB-1 de `phase-03-videos/TD-12`).

### Error Catalog

Formato herdado `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). Novas `DomainException` em `src/common/exceptions/domain.exception.ts`:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, de outro canal (rotas do dono) ou não `ready` (rotas públicas) |
| VIDEO_NOT_UPLOADABLE | 409 | Operação de upload em vídeo cujo status ≠ `draft` |
| VIDEO_FILE_TOO_LARGE | 400 | `size` declarado ou objeto montado > `VIDEO_MAX_UPLOAD_BYTES` |
| INVALID_PART_RANGE | 400 | Intervalo `from`/`to` inválido para o upload |
| UPLOAD_INCOMPLETE | 400 | Lista de partes do complete inconsistente ou rejeitada pelo storage |
| RANGE_NOT_SATISFIABLE | 416 | Header `Range` inválido ou fora do arquivo — resposta inclui `Content-Range: bytes */size` |
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal ao iniciar upload |

`DomainException` ganha um campo opcional `headers: Record<string, string>` que o `DomainExceptionFilter` aplica na resposta (necessário para o `Content-Range` do 416); exceções existentes não mudam.

### Events/Messages

#### video.process

**Queue:** `video-processing` (BullMQ sobre Redis, per `phase-03-videos/TD-04`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId: videoId` (enqueue idempotente), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: 100` (per `phase-03-videos/TD-10`)

**Producer:** `VideoProcessingProducer` (API, chamado por `VideoUploadsService.complete`) (per `phase-03-videos/TD-09`)
**Consumer:** `VideoProcessor` (`@Processor('video-processing')`, `WorkerHost`) registrado **só** no `WorkerModule` do container `video-worker` (per `phase-03-videos/TD-05`); delega para `VideoProcessingService`
**Trigger:** `POST /videos/:id/upload/complete` após `CompleteMultipartUpload` bem-sucedido e status → `processing`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-04`). O processamento é idempotente: um vídeo que não está em `processing` é ignorado (ack sem efeito); reprocessar sobrescreve a mesma `thumbnail_key`.

**Processing (per `phase-03-videos/TD-06`):**
1. Carrega o vídeo; se status ≠ `processing`, retorna sem efeito.
2. Gera URL `GetObject` pré-assinada para o **endpoint interno** (`S3_ENDPOINT`) — o FFmpeg lê por HTTP Range, sem baixar o arquivo inteiro.
3. `ffprobe -v error -print_format json -show_format -show_streams <url>` → `duration_seconds` (`format.duration`) + `metadata`. Sem stream de vídeo ou saída ilegível → `UnrecoverableError` (falha permanente, sem retry).
4. `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1`, com `t = duration × 0.1` (`t = 0` para vídeos < 1s) → JPEG → `PutObject` em `videos/{id}/thumbnail.jpg`.
5. Atualiza `status = ready`, `duration_seconds`, `metadata`, `thumbnail_key`, `processing_error = null`.

**Failure (per `phase-03-videos/TD-10`):** `@OnWorkerEvent('failed')` → se for `UnrecoverableError` ou `job.attemptsMade ≥ job.opts.attempts`, `VideoProcessingService.markFailed(videoId, error.message)` → `status = failed`, `processing_error = message`. Falhas intermediárias apenas re-agendam (backoff exponencial).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
└── SI-03.4
    └── SI-03.5

SI-03.2 + SI-03.5
└── SI-03.6
    └── SI-03.7 (+ SI-03.3)

SI-03.1 + SI-03.2 + SI-03.3
└── SI-03.8

SI-03.5 + SI-03.7 + SI-03.8
└── SI-03.9

SI-03.2 + SI-03.5 + SI-03.6
└── SI-03.10

SI-03.7 + SI-03.9 + SI-03.10
└── SI-03.11
    └── SI-03.12
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12

---

## Deliverables

- [ ] SI-03.1 — Redis e MinIO no Compose com healthcheck, FFmpeg na imagem, namespaces `storage`/`queue`/`video` validados por Joi
- [ ] SI-03.2 — `StorageModule` com multipart pré-assinado, leitura por Range e bootstrap idempotente do bucket (CORS + lifecycle)
- [ ] SI-03.3 — `QueueModule` (BullMQ/Redis) e constantes da fila `video-processing`
- [ ] SI-03.4 — Entidade `Video` ligada ao canal e migration `CreateVideos`
- [ ] SI-03.5 — `VideosService` com slug único de 11 chars e transições de status
- [ ] SI-03.6 — `POST /videos`, `GET /videos/:id`, `GET /videos/:id/upload/parts` (upload de até 10GB direto ao storage, rascunho pré-cadastrado)
- [ ] SI-03.7 — `POST /videos/:id/upload/complete` (202 + job `video.process`) e `DELETE /videos/:id/upload`
- [ ] SI-03.8 — Container `video-worker` (segundo entrypoint) e `FfmpegService`
- [ ] SI-03.9 — Processamento: duração, metadados, thumbnail e `ready`/`failed` com 3 tentativas
- [ ] SI-03.10 — `GET /videos/:slug/stream` (206), `/download` e `/thumbnail` públicos
- [ ] SI-03.11 — E2E do pipeline completo (sucesso e falha) e `openapi.json` sincronizado
- [ ] SI-03.12 — `CLAUDE.md`, README e diagrama coerentes com o código
- [ ] Unit + integration tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
