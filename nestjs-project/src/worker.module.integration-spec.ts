import { Test } from '@nestjs/testing';
import { VideoProcessor } from './video-processing/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  it('should resolve the consumer with every entity relation available', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    await module.close();
  });
});
