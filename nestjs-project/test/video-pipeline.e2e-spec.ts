import { INestApplicationContext, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { putToPresignedUrl } from '../src/test/storage';
import { generateTestVideo } from '../src/test/video-fixture';
import { WorkerModule } from '../src/worker.module';
import {
  createTestUser,
  createVideoTestApp,
  TestUser,
} from './helpers/video-app';

const TERMINAL = ['ready', 'failed'];
const PIPELINE_TIMEOUT_MS = 60000;

describe('Video pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let owner: TestUser;

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${owner.token}`);

  async function uploadAndComplete(content: Buffer) {
    const session = await authed(request(app.getHttpServer()).post('/videos'))
      .send({
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size: content.length,
      })
      .expect(201);
    const { id, slug } = session.body.video as { id: string; slug: string };

    const parts = await authed(
      request(app.getHttpServer()).get(
        `/videos/${id}/upload/parts?from=1&to=1`,
      ),
    ).expect(200);
    const upload = await putToPresignedUrl(parts.body.parts[0].url, content);
    expect(upload.status).toBe(200);

    const completed = await authed(
      request(app.getHttpServer()).post(`/videos/${id}/upload/complete`),
    )
      .send({
        parts: [{ part_number: 1, etag: upload.headers.get('etag') }],
      })
      .expect(202);
    expect(completed.body.status).toBe('processing');
    return { id, slug };
  }

  async function waitForTerminalStatus(id: string) {
    const deadline = Date.now() + PIPELINE_TIMEOUT_MS - 5000;
    for (;;) {
      const res = await authed(
        request(app.getHttpServer()).get(`/videos/${id}`),
      ).expect(200);
      if (TERMINAL.includes(res.body.status as string)) return res.body;
      if (Date.now() > deadline) {
        throw new Error(`Video stuck in status ${res.body.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
    app = await createVideoTestApp();
    // In-process so the test does not depend on the video-worker container.
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
  });

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    owner = await createTestUser(app);
  });

  afterAll(async () => {
    await worker.close();
    await cleanAllTables(app.get(DataSource));
    await app.close();
  });

  it(
    'should take a video from upload to streaming without manual steps',
    async () => {
      const content = await generateTestVideo(2);

      const { id, slug } = await uploadAndComplete(content);
      const video = await waitForTerminalStatus(id);

      expect(video.status).toBe('ready');
      expect(video.processing_error).toBeNull();
      expect(video.duration_seconds).toBeCloseTo(2, 0);
      expect(video.metadata).toMatchObject({ width: 320, height: 240 });
      expect(video.thumbnail_url).toBe(`/videos/${slug}/thumbnail`);

      const stream = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Range', 'bytes=0-99')
        .expect(206);
      expect(stream.headers['content-range']).toBe(
        `bytes 0-99/${content.length}`,
      );

      const thumbnail = await request(app.getHttpServer())
        .get(`/videos/${slug}/thumbnail`)
        .expect(200);
      expect(thumbnail.headers['content-type']).toContain('image/jpeg');
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    'should end in failed with the reason when the file is not a video',
    async () => {
      const { id, slug } = await uploadAndComplete(randomBytes(64 * 1024));

      const video = await waitForTerminalStatus(id);

      expect(video.status).toBe('failed');
      expect(video.processing_error).toEqual(expect.any(String));
      expect(video.processing_error).not.toContain('X-Amz-Signature');
      await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(404);
    },
    PIPELINE_TIMEOUT_MS,
  );
});
