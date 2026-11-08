import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import * as slugUtil from './slug.util';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let owner: User;
  let channel: Channel;

  const draftInput = () => {
    const id = randomUUID();
    return {
      id,
      channel_id: channel.id,
      title: 'Aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 2048,
      storage_key: `videos/${id}/original`,
      upload_id: 'upload-id',
    };
  };

  const createUser = async (email: string) => {
    const user = await dataSource
      .getRepository(User)
      .save({ email, password: 'hash' });
    const created = await dataSource.getRepository(Channel).save({
      name: email.split('@')[0],
      nickname: email.split('@')[0],
      user_id: user.id,
    });
    return { user, channel: created };
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
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
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideosRepository, VideosService],
    }).compile();
    dataSource = module.get<DataSource>(getDataSourceToken());
    service = module.get(VideosService);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    ({ user: owner, channel } = await createUser('owner@example.com'));
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  });

  it('should create a draft with an 11-character base62 slug', async () => {
    const video = await service.createDraft(draftInput());

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.slug).toMatch(/^[0-9A-Za-z]{11}$/);
  });

  it('should pick another slug when the generated one already exists', async () => {
    const existing = await service.createDraft(draftInput());
    jest
      .spyOn(slugUtil, 'generateVideoSlug')
      .mockReturnValueOnce(existing.slug)
      .mockReturnValueOnce('freshSlug01');

    const video = await service.createDraft(draftInput());

    expect(video.slug).toBe('freshSlug01');
  });

  it('should find a video only for its owner', async () => {
    const video = await service.createDraft(draftInput());
    const { user: stranger } = await createUser('other@example.com');

    await expect(
      service.findOwnedById(video.id, owner.id),
    ).resolves.toMatchObject({ id: video.id });
    await expect(
      service.findOwnedById(video.id, stranger.id),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should only resolve ready videos by slug', async () => {
    const video = await service.createDraft(draftInput());
    await service.markProcessing(video.id, 4096);

    await expect(service.findReadyBySlug(video.slug)).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );

    await service.markReady(video.id, {
      durationSeconds: 2,
      metadata: {
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: null,
        formatName: 'mp4',
        bitRate: 1000,
        frameRate: 25,
      },
      thumbnailKey: `videos/${video.id}/thumbnail.jpg`,
    });

    await expect(service.findReadyBySlug(video.slug)).resolves.toMatchObject({
      size_bytes: 4096,
      duration_seconds: 2,
      upload_id: null,
      status: VideoStatus.READY,
    });
  });

  it('should persist the failure message and clear it once ready', async () => {
    const video = await service.createDraft(draftInput());

    await service.markFailed(video.id, 'ffprobe failed');
    await expect(service.getById(video.id)).resolves.toMatchObject({
      status: VideoStatus.FAILED,
      processing_error: 'ffprobe failed',
    });

    await service.markReady(video.id, {
      durationSeconds: 1,
      metadata: {
        width: null,
        height: null,
        videoCodec: null,
        audioCodec: null,
        formatName: null,
        bitRate: null,
        frameRate: null,
      },
      thumbnailKey: 'k',
    });
    await expect(service.getById(video.id)).resolves.toMatchObject({
      processing_error: null,
    });
  });

  it('should remove a video', async () => {
    const video = await service.createDraft(draftInput());

    await service.remove(video.id);

    await expect(service.getById(video.id)).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });
});
