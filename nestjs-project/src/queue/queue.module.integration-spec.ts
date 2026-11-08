import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { QueueModule } from './queue.module';

describe('QueueModule (integration)', () => {
  let module: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
    }).compile();
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.close();
    await module.close();
  });

  it('should reach Redis through the root connection', async () => {
    await queue.waitUntilReady();

    await expect(queue.getJobCounts('waiting')).resolves.toEqual(
      expect.objectContaining({ waiting: expect.any(Number) }),
    );
  });

  it('should connect to the Compose service host, not localhost', () => {
    expect(queue.opts.connection).toMatchObject({
      host: process.env.REDIS_HOST ?? 'redis',
    });
  });
});
