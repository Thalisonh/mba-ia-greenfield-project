import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import { FfmpegService, InvalidMediaError } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

const metadata = {
  width: 320,
  height: 240,
  videoCodec: 'h264',
  audioCodec: null,
  formatName: 'mp4',
  bitRate: 1,
  frameRate: 25,
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const videos = { findById: jest.fn(), markReady: jest.fn() };
  const storage = {
    presignInternalGetObject: jest.fn(),
    putObject: jest.fn(),
  };
  const ffmpeg = { probe: jest.fn(), extractThumbnail: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: VideosService, useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
        { provide: videoConfig.KEY, useValue: { presignExpiresSeconds: 60 } },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
    videos.findById.mockResolvedValue({
      id: 'v',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/v/original',
    });
    storage.presignInternalGetObject.mockResolvedValue('http://signed');
    ffmpeg.extractThumbnail.mockResolvedValue(Buffer.from('jpeg'));
  });

  it.each([
    ['missing', null],
    ['already ready', { id: 'v', status: VideoStatus.READY }],
  ])('should ignore a video that is %s', async (_name, video) => {
    videos.findById.mockResolvedValue(video);

    await service.process('v');

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(videos.markReady).not.toHaveBeenCalled();
  });

  it('should treat a file without a video stream as permanent', async () => {
    ffmpeg.probe.mockResolvedValue({
      hasVideoStream: false,
      durationSeconds: 2,
      metadata,
    });

    await expect(service.process('v')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('should treat unreadable media as permanent', async () => {
    ffmpeg.probe.mockRejectedValue(new InvalidMediaError('bad'));

    await expect(service.process('v')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('should keep transient failures retryable', async () => {
    const failure = new Error('connection reset');
    ffmpeg.probe.mockRejectedValue(failure);

    await expect(service.process('v')).rejects.toBe(failure);
  });

  it('should take the thumbnail at 10% and mark the video ready', async () => {
    ffmpeg.probe.mockResolvedValue({
      hasVideoStream: true,
      durationSeconds: 20,
      metadata,
    });

    await service.process('v');

    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith('http://signed', 2);
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/v/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videos.markReady).toHaveBeenCalledWith('v', {
      durationSeconds: 20,
      metadata,
      thumbnailKey: 'videos/v/thumbnail.jpg',
    });
  });

  it('should take the first frame of clips shorter than a second', async () => {
    ffmpeg.probe.mockResolvedValue({
      hasVideoStream: true,
      durationSeconds: 0.4,
      metadata,
    });

    await service.process('v');

    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith('http://signed', 0);
  });
});
