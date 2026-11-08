import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageBootstrapService } from '../storage/storage-bootstrap.service';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  putToPresignedUrl,
  useInternalHostForPresignedUrls,
} from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideosModule } from './videos.module';

const MIB = 1024 ** 2;

describe('VideoUploadsService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideoUploadsService;
  let storage: StorageService;
  let userId: string;

  beforeAll(async () => {
    useInternalHostForPresignedUrls();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
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
        VideosModule,
      ],
    }).compile();
    dataSource = module.get<DataSource>(getDataSourceToken());
    service = module.get(VideoUploadsService);
    storage = module.get(StorageService);
    await module.get(StorageBootstrapService).ensureBucket();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hash' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  });

  it('should pre-register a draft with an open multipart upload', async () => {
    const session = await service.initiate(userId, {
      filename: 'aula.mp4',
      content_type: 'video/mp4',
      size: 100 * MIB,
    });

    const saved = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: session.video.id });
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.title).toBe('aula');
    expect(saved.storage_key).toBe(`videos/${saved.id}/original`);
    await expect(
      storage.listParts(saved.storage_key, saved.upload_id as string),
    ).resolves.toEqual([]);
    expect(session.upload.part_count).toBe(2);

    await storage.abortMultipartUpload(
      saved.storage_key,
      saved.upload_id as string,
    );
  });

  it('should issue part URLs that accept the bytes and report them as uploaded', async () => {
    const session = await service.initiate(userId, {
      filename: 'aula.mp4',
      content_type: 'video/mp4',
      size: 100 * MIB,
    });

    const { parts } = await service.getPartUrls(userId, session.video.id, 1, 2);
    const response = await putToPresignedUrl(
      parts[0].url,
      randomBytes(5 * MIB),
    );
    const resumed = await service.getPartUrls(userId, session.video.id, 2, 2);

    expect(response.status).toBe(200);
    expect(resumed.uploaded_parts).toEqual([
      {
        part_number: 1,
        etag: response.headers.get('etag'),
        size: 5 * MIB,
      },
    ]);

    const saved = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: session.video.id });
    await storage.abortMultipartUpload(
      saved.storage_key,
      saved.upload_id as string,
    );
  });
});
