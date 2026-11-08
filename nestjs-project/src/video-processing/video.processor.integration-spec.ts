import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

async function waitFor(condition: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Real BullMQ worker: pins down what `attemptsMade` really is on `failed`. */
describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let queue: Queue;
  const service = { process: jest.fn(), markFailed: jest.fn() };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          // Isolated from the queue consumed by the running video-worker.
          prefix: `test-${randomUUID()}`,
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: service },
      ],
    }).compile();
    await module.init();
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should retry and mark the video failed exactly once, after the last attempt', async () => {
    service.process.mockRejectedValue(new Error('storage blip'));
    const videoId = randomUUID();

    await queue.add(
      'video.process',
      { videoId },
      { attempts: 3, backoff: { type: 'fixed', delay: 10 }, jobId: videoId },
    );
    await waitFor(() => service.markFailed.mock.calls.length > 0);

    expect(service.process).toHaveBeenCalledTimes(3);
    expect(service.markFailed).toHaveBeenCalledTimes(1);
    expect(service.markFailed).toHaveBeenCalledWith(videoId, 'storage blip');
  });
});
