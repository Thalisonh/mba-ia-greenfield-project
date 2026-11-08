import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { putToPresignedUrl } from '../src/test/storage';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createTestUser,
  createVideoTestApp,
  TestUser,
} from './helpers/video-app';

const MIB = 1024 ** 2;
const TEN_GIB = 10737418240;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let owner: TestUser;

  const startUpload = (token: string, size = 100 * MIB) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'aula.mp4', content_type: 'video/mp4', size });

  beforeAll(async () => {
    app = await createVideoTestApp();
  });

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    owner = await createTestUser(app);
  });

  afterAll(async () => {
    await cleanAllTables(app.get(DataSource));
    await app.close();
  });

  describe('POST /videos', () => {
    it('should pre-register a draft for a 10 GiB file split in 160 parts', async () => {
      const res = await startUpload(owner.token, TEN_GIB).expect(201);

      expect(res.body.video).toMatchObject({
        status: 'draft',
        title: 'aula',
        size_bytes: TEN_GIB,
        duration_seconds: null,
        thumbnail_url: null,
      });
      expect(res.body.video.slug).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(res.body.video.stream_url).toBe(
        `/videos/${res.body.video.slug}/stream`,
      );
      expect(res.body.upload).toEqual({
        part_size: 67108864,
        part_count: 160,
        expires_in_seconds: 3600,
      });
    });

    it('should reject a file above 10 GiB', async () => {
      const res = await startUpload(owner.token, TEN_GIB + 1).expect(400);

      expect(res.body.error).toBe('VIDEO_FILE_TOO_LARGE');
    });

    it('should reject a non-video content type', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ filename: 'a.png', content_type: 'image/png', size: 10 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should require authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ filename: 'a.mp4', content_type: 'video/mp4', size: 10 })
        .expect(401);
    });

    it('should give distinct URLs to two uploads of the same file', async () => {
      const first = await startUpload(owner.token).expect(201);
      const second = await startUpload(owner.token).expect(201);

      expect(first.body.video.slug).not.toBe(second.body.video.slug);
    });
  });

  describe('GET /videos/:id', () => {
    it('should return the video to its owner', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${body.video.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(res.body.id).toBe(body.video.id);
    });

    it('should answer 404 to another user', async () => {
      const { body } = await startUpload(owner.token).expect(201);
      const stranger = await createTestUser(app);

      const res = await request(app.getHttpServer())
        .get(`/videos/${body.video.id}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should reject an id that is not a UUID', async () => {
      await request(app.getHttpServer())
        .get('/videos/not-a-uuid')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(400);
    });
  });

  describe('GET /videos/:id/upload/parts', () => {
    const getParts = (token: string, id: string, query: string) =>
      request(app.getHttpServer())
        .get(`/videos/${id}/upload/parts?${query}`)
        .set('Authorization', `Bearer ${token}`);

    it('should issue URLs that accept a part and then list it as uploaded', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      const first = await getParts(
        owner.token,
        body.video.id,
        'from=1&to=2',
      ).expect(200);
      expect(first.body.parts).toHaveLength(2);

      const upload = await putToPresignedUrl(
        first.body.parts[0].url,
        randomBytes(5 * MIB),
      );
      expect(upload.status).toBe(200);

      const resumed = await getParts(
        owner.token,
        body.video.id,
        'from=2&to=2',
      ).expect(200);
      expect(resumed.body.uploaded_parts).toEqual([
        {
          part_number: 1,
          etag: upload.headers.get('etag'),
          size: 5 * MIB,
        },
      ]);
    });

    it('should reject an inverted range', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      const res = await getParts(
        owner.token,
        body.video.id,
        'from=3&to=1',
      ).expect(400);

      expect(res.body.error).toBe('INVALID_PART_RANGE');
    });

    it('should validate the query string', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      const res = await getParts(
        owner.token,
        body.video.id,
        'from=abc&to=1',
      ).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should answer 404 for an unknown video', async () => {
      await getParts(owner.token, randomUUID(), 'from=1&to=1').expect(404);
    });

    it('should not be rate limited', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      for (let i = 0; i < 15; i++) {
        await getParts(owner.token, body.video.id, 'from=1&to=1').expect(200);
      }
    });
  });

  describe('complete and cancel', () => {
    const authed = (req: request.Test, token: string) =>
      req.set('Authorization', `Bearer ${token}`);

    /** Starts a one-part upload, sends the bytes and returns what complete needs. */
    async function uploadSinglePart(declaredSize: number, actualSize: number) {
      const { body } = await startUpload(owner.token, declaredSize).expect(201);
      const parts = await authed(
        request(app.getHttpServer()).get(
          `/videos/${body.video.id}/upload/parts?from=1&to=1`,
        ),
        owner.token,
      ).expect(200);
      const upload = await putToPresignedUrl(
        parts.body.parts[0].url,
        randomBytes(actualSize),
      );
      return {
        id: body.video.id as string,
        parts: [{ part_number: 1, etag: upload.headers.get('etag') }],
      };
    }

    const complete = (id: string, parts: unknown) =>
      authed(
        request(app.getHttpServer()).post(`/videos/${id}/upload/complete`),
        owner.token,
      ).send({ parts });

    it('should complete the upload, record the real size and enqueue the job', async () => {
      const { id, parts } = await uploadSinglePart(2 * MIB, MIB);

      const res = await complete(id, parts).expect(202);

      expect(res.body).toMatchObject({ status: 'processing', size_bytes: MIB });
      const job = await app
        .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
        .getJob(id);
      expect(job?.name).toBe('video.process');
      expect(job?.data).toEqual({ videoId: id });
    });

    it('should reject a second complete', async () => {
      const { id, parts } = await uploadSinglePart(MIB, MIB);
      await complete(id, parts).expect(202);

      const res = await complete(id, parts).expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_UPLOADABLE');
    });

    it('should reject a list with missing parts and keep the draft', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      const res = await complete(body.video.id, [
        { part_number: 1, etag: 'etag' },
      ]).expect(400);

      expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
      const video = await authed(
        request(app.getHttpServer()).get(`/videos/${body.video.id}`),
        owner.token,
      ).expect(200);
      expect(video.body.status).toBe('draft');
    });

    it('should reject an ETag the storage does not know', async () => {
      const { id } = await uploadSinglePart(MIB, MIB);

      const res = await complete(id, [
        { part_number: 1, etag: '"00000000000000000000000000000000"' },
      ]).expect(400);

      expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
    });

    it('should validate the body', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      const res = await complete(body.video.id, []).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should cancel a draft and forget it', async () => {
      const { body } = await startUpload(owner.token).expect(201);

      await authed(
        request(app.getHttpServer()).delete(`/videos/${body.video.id}/upload`),
        owner.token,
      ).expect(204);

      await authed(
        request(app.getHttpServer()).get(`/videos/${body.video.id}`),
        owner.token,
      ).expect(404);
    });

    it('should refuse to cancel a video already processing', async () => {
      const { id, parts } = await uploadSinglePart(MIB, MIB);
      await complete(id, parts).expect(202);

      const res = await authed(
        request(app.getHttpServer()).delete(`/videos/${id}/upload`),
        owner.token,
      ).expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_UPLOADABLE');
    });
  });
});
