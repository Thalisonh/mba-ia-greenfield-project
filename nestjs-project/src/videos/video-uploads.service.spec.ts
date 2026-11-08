import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartRangeException,
  VideoFileTooLargeException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideosService } from './videos.service';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const dto = {
  filename: 'aula.final.mp4',
  content_type: 'video/mp4',
  size: MIB,
};

const draft = (overrides: Partial<Video> = {}): Video =>
  ({
    id: 'video-id',
    slug: 'aZ09bY18cX2',
    status: VideoStatus.DRAFT,
    size_bytes: 100 * MIB,
    storage_key: 'videos/video-id/original',
    upload_id: 'upload-id',
    thumbnail_key: null,
    ...overrides,
  }) as Video;

describe('VideoUploadsService', () => {
  let service: VideoUploadsService;
  const videos = { createDraft: jest.fn(), findOwnedById: jest.fn() };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoUploadsService,
        { provide: VideosService, useValue: videos },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        {
          provide: videoConfig.KEY,
          useValue: {
            maxUploadBytes: 10 * GIB,
            uploadPartSizeBytes: 64 * MIB,
            presignExpiresSeconds: 3600,
          },
        },
      ],
    }).compile();
    service = module.get(VideoUploadsService);
    channels.findByUserId.mockResolvedValue({ id: 'channel-id' });
    storage.createMultipartUpload.mockResolvedValue('upload-id');
    storage.presignUploadPart.mockResolvedValue('https://signed');
    storage.listParts.mockResolvedValue([]);
  });

  describe('initiate', () => {
    it('should reject a file above the limit before touching the storage', async () => {
      await expect(
        service.initiate('user', { ...dto, size: 10 * GIB + 1 }),
      ).rejects.toBeInstanceOf(VideoFileTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should fail when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.initiate('user', dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
    });

    it('should split 10 GiB into 160 parts of 64 MiB', async () => {
      videos.createDraft.mockResolvedValue(draft({ size_bytes: 10 * GIB }));

      const session = await service.initiate('user', {
        ...dto,
        size: 10 * GIB,
      });

      expect(session.upload).toEqual({
        part_size: 64 * MIB,
        part_count: 160,
        expires_in_seconds: 3600,
      });
    });

    it('should default the title to the file name without its extension', async () => {
      videos.createDraft.mockResolvedValue(draft());

      await service.initiate('user', dto);

      expect(videos.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'aula.final' }),
      );
    });

    it('should abort the multipart upload when the draft cannot be saved', async () => {
      const failure = new Error('db down');
      videos.createDraft.mockRejectedValue(failure);

      await expect(service.initiate('user', dto)).rejects.toBe(failure);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-id',
      );
    });
  });

  describe('getPartUrls', () => {
    it.each([
      ['to before from', 3, 1],
      ['more than 100 parts', 1, 101],
      ['beyond the last part', 1, 3],
    ])('should reject %s', async (_name, from, to) => {
      videos.findOwnedById.mockResolvedValue(
        draft({ size_bytes: from === 1 && to === 101 ? 10 * GIB : 100 * MIB }),
      );

      await expect(
        service.getPartUrls('user', 'video-id', from, to),
      ).rejects.toBeInstanceOf(InvalidPartRangeException);
    });

    it('should reject videos that are no longer drafts', async () => {
      videos.findOwnedById.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getPartUrls('user', 'video-id', 1, 1),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });

    it('should sign exactly the requested parts', async () => {
      videos.findOwnedById.mockResolvedValue(draft());

      const result = await service.getPartUrls('user', 'video-id', 1, 2);

      expect(result.parts.map((p) => p.part_number)).toEqual([1, 2]);
      expect(storage.presignUploadPart).toHaveBeenCalledTimes(2);
    });
  });
});
