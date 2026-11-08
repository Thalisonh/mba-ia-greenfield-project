import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { VideoProcessJobData } from '../videos/video-processing.producer';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor', () => {
  const service = { process: jest.fn(), markFailed: jest.fn() };
  const processor = new VideoProcessor(
    service as unknown as VideoProcessingService,
  );

  const job = (attemptsMade: number) =>
    ({
      data: { videoId: 'v' },
      attemptsMade,
      opts: { attempts: 3 },
    }) as unknown as Job<VideoProcessJobData>;

  beforeEach(() => jest.resetAllMocks());

  it('should delegate the job to the processing service', async () => {
    await processor.process(job(0));

    expect(service.process).toHaveBeenCalledWith('v');
  });

  it('should not mark the video failed on an intermediate attempt', async () => {
    await processor.onFailed(job(1), new Error('blip'));

    expect(service.markFailed).not.toHaveBeenCalled();
  });

  it('should mark the video failed on the last attempt', async () => {
    await processor.onFailed(job(3), new Error('blip'));

    expect(service.markFailed).toHaveBeenCalledWith('v', 'blip');
  });

  it('should mark the video failed at once on an unrecoverable error', async () => {
    await processor.onFailed(job(1), new UnrecoverableError('corrupt'));

    expect(service.markFailed).toHaveBeenCalledWith('v', 'corrupt');
  });

  it('should not throw when marking the failure fails', async () => {
    service.markFailed.mockRejectedValue(new Error('db down'));

    await expect(
      processor.onFailed(job(3), new Error('blip')),
    ).resolves.toBeUndefined();
  });
});
