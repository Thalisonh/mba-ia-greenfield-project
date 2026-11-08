import { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createTestUser,
  createVideoTestApp,
  TestUser,
} from './helpers/video-app';

const binary = (
  res: request.Response,
  callback: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let storage: StorageService;
  let owner: TestUser;
  const keys: string[] = [];

  async function seedVideo(
    content: Buffer,
    status = VideoStatus.READY,
    filename = 'aula.mp4',
  ): Promise<Video> {
    const id = randomUUID();
    const storageKey = `videos/${id}/original`;
    const thumbnailKey = `videos/${id}/thumbnail.jpg`;
    await storage.putObject(storageKey, content, 'video/mp4');
    await storage.putObject(thumbnailKey, Buffer.from('jpeg'), 'image/jpeg');
    keys.push(storageKey, thumbnailKey);
    return app
      .get(DataSource)
      .getRepository(Video)
      .save({
        id,
        channel_id: owner.channel.id,
        slug: id.replace(/-/g, '').slice(0, 11),
        title: 'Aula',
        status,
        original_filename: filename,
        content_type: 'video/mp4',
        size_bytes: content.length,
        storage_key: storageKey,
        thumbnail_key: thumbnailKey,
      });
  }

  const get = (path: string) =>
    request(app.getHttpServer()).get(path).buffer(true).parse(binary);

  beforeAll(async () => {
    app = await createVideoTestApp();
    storage = app.get(StorageService);
  });

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    owner = await createTestUser(app);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await cleanAllTables(app.get(DataSource));
    await app.close();
  });

  describe('GET /videos/:slug/stream', () => {
    it('should answer a range request anonymously with 206 and the exact bytes', async () => {
      const content = randomBytes(4096);
      const video = await seedVideo(content);

      const res = await get(`/videos/${video.slug}/stream`)
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(res.headers['content-range']).toBe('bytes 0-1023/4096');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toContain('video/mp4');
      expect(res.headers['content-length']).toBe('1024');
      expect((res.body as Buffer).equals(content.subarray(0, 1024))).toBe(true);
    });

    it('should serve a suffix range', async () => {
      const content = randomBytes(4096);
      const video = await seedVideo(content);

      const res = await get(`/videos/${video.slug}/stream`)
        .set('Range', 'bytes=-100')
        .expect(206);

      expect((res.body as Buffer).equals(content.subarray(3996))).toBe(true);
    });

    it('should stream the whole file without a Range header', async () => {
      const content = randomBytes(4096);
      const video = await seedVideo(content);

      const res = await get(`/videos/${video.slug}/stream`).expect(200);

      expect(res.headers['content-length']).toBe('4096');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect((res.body as Buffer).equals(content)).toBe(true);
    });

    it('should answer 416 with the size for an unsatisfiable range', async () => {
      const video = await seedVideo(randomBytes(4096));

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .set('Range', 'bytes=4096-')
        .expect(416);

      expect(res.headers['content-range']).toBe('bytes */4096');
      expect(res.body.error).toBe('RANGE_NOT_SATISFIABLE');
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should hide a %s video',
      async (status) => {
        const video = await seedVideo(randomBytes(16), status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.slug}/stream`)
          .expect(404);

        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      },
    );

    it('should answer 404 for an unknown slug and 400 for a malformed one', async () => {
      await request(app.getHttpServer())
        .get('/videos/aaaaaaaaaaa/stream')
        .expect(404);
      await request(app.getHttpServer())
        .get('/videos/bad-slug/stream')
        .expect(400);
    });

    it('should not be rate limited', async () => {
      const video = await seedVideo(randomBytes(64));

      for (let i = 0; i < 15; i++) {
        await get(`/videos/${video.slug}/stream`)
          .set('Range', 'bytes=0-1')
          .expect(206);
      }
    });

    it('should release the storage stream when the client disconnects', async () => {
      const video = await seedVideo(randomBytes(8 * 1024 * 1024));
      const original = storage.getObjectStream.bind(storage);
      let body: Readable | undefined;
      jest
        .spyOn(storage, 'getObjectStream')
        .mockImplementation(async (key, range) => {
          const object = await original(key, range);
          body = object.body;
          return object;
        });

      const server = (app.getHttpServer() as unknown as http.Server).listen(0);
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve) => {
        const req = http.get(
          { port, path: `/videos/${video.slug}/stream` },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', () => undefined);
      });

      for (let i = 0; i < 100 && !body?.destroyed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => server.close(resolve));
      expect(body?.destroyed).toBe(true);
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('should send the file as an attachment', async () => {
      const content = randomBytes(1024);
      const video = await seedVideo(content);

      const res = await get(`/videos/${video.slug}/download`).expect(200);

      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="aula.mp4"',
      );
      expect((res.body as Buffer).equals(content)).toBe(true);
    });

    it('should neutralize quotes in the file name', async () => {
      const video = await seedVideo(
        randomBytes(16),
        VideoStatus.READY,
        'a"b.mp4',
      );

      const res = await get(`/videos/${video.slug}/download`).expect(200);

      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="a_b.mp4"',
      );
    });

    it('should support resuming with a range', async () => {
      const content = randomBytes(1024);
      const video = await seedVideo(content);

      const res = await get(`/videos/${video.slug}/download`)
        .set('Range', 'bytes=1000-')
        .expect(206);

      expect((res.body as Buffer).equals(content.subarray(1000))).toBe(true);
    });
  });

  describe('GET /videos/:slug/thumbnail', () => {
    it('should return the JPEG anonymously', async () => {
      const video = await seedVideo(randomBytes(16));

      const res = await get(`/videos/${video.slug}/thumbnail`).expect(200);

      expect(res.headers['content-type']).toContain('image/jpeg');
      expect((res.body as Buffer).toString()).toBe('jpeg');
    });

    it('should answer 404 while the video is not ready', async () => {
      const video = await seedVideo(randomBytes(16), VideoStatus.PROCESSING);

      await request(app.getHttpServer())
        .get(`/videos/${video.slug}/thumbnail`)
        .expect(404);
    });
  });
});
