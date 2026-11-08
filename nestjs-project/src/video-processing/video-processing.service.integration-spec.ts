import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { QueueModule } from '../queue/queue.module';
import { StorageBootstrapService } from '../storage/storage-bootstrap.service';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { generateTestVideo } from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideoProcessingService;
  let storage: StorageService;
  let channelId: string;

  async function seedProcessingVideo(content: Buffer): Promise<Video> {
    const id = randomUUID();
    const storageKey = `videos/${id}/original`;
    await storage.putObject(storageKey, content, 'video/mp4');
    return dataSource.getRepository(Video).save({
      id,
      channel_id: channelId,
      slug: id.replace(/-/g, '').slice(0, 11),
      title: 'Aula',
      status: VideoStatus.PROCESSING,
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: content.length,
      storage_key: storageKey,
    });
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig, queueConfig],
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_NAME ?? 'streamtube',
          entities: [User, Channel, RefreshToken, VerificationToken, Video],
          synchronize: false,
        }),
        QueueModule,
        VideoProcessingModule,
      ],
    }).compile();
    dataSource = module.get<DataSource>(getDataSourceToken());
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    await module.get(StorageBootstrapService).ensureBucket();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hash' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    channelId = channel.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  });

  it('should extract metadata, store the thumbnail and mark the video ready', async () => {
    const video = await seedProcessingVideo(await generateTestVideo(2));

    await service.process(video.id);

    const saved = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBeCloseTo(2, 0);
    expect(saved.metadata).toMatchObject({ width: 320, videoCodec: 'h264' });
    expect(saved.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    const head = await storage.headObject(saved.thumbnail_key as string);
    expect(head.contentType).toBe('image/jpeg');
    expect(head.contentLength).toBeGreaterThan(0);
  });

  it('should fail permanently on a file that is not a video', async () => {
    const video = await seedProcessingVideo(randomBytes(4096));

    await expect(service.process(video.id)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('should leave a ready video untouched when processed again', async () => {
    const video = await seedProcessingVideo(await generateTestVideo(1));
    await service.process(video.id);
    const before = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });

    await service.process(video.id);

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.updated_at).toEqual(before.updated_at);
  });
});
