import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channel: Channel;

  const buildVideo = (overrides: Partial<Video> = {}): Partial<Video> => {
    const id = randomUUID();
    return {
      id,
      channel_id: channel.id,
      slug: randomUUID().replace(/-/g, '').slice(0, 11),
      title: 'Aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/original`,
      ...overrides,
    };
  };

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      { synchronize: false },
    );
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'owner@example.com',
      password: 'hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: 'owner',
      user_id: user.id,
    });
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  it('should default status to draft and nullable fields to null', async () => {
    const { id } = await videos.save(buildVideo());

    const saved = await videos.findOneByOrFail({ id });

    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.duration_seconds).toBeNull();
    expect(saved.metadata).toBeNull();
    expect(saved.processing_error).toBeNull();
  });

  it('should reject a duplicated slug', async () => {
    await videos.save(buildVideo({ slug: 'abcdefghijk' }));

    await expect(
      videos.insert(buildVideo({ slug: 'abcdefghijk' })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should reject a video for a channel that does not exist', async () => {
    await expect(
      videos.insert(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('should read a 10 GiB size back as a number', async () => {
    const { id } = await videos.save(buildVideo({ size_bytes: 10737418240 }));

    const saved = await videos.findOneByOrFail({ id });

    expect(saved.size_bytes).toBe(10737418240);
  });

  it('should round-trip metadata as json and load the channel relation', async () => {
    const metadata = {
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: null,
      formatName: 'mov,mp4',
      bitRate: 1000,
      frameRate: 25,
    };
    const { id } = await videos.save(buildVideo({ metadata }));

    const saved = await videos.findOneOrFail({
      where: { id },
      relations: ['channel'],
    });

    expect(saved.metadata).toEqual(metadata);
    expect(saved.channel.id).toBe(channel.id);
  });
});
