import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

export interface VideoProcessJobData {
  videoId: string;
}

/** Publishes `video.process`; `jobId = videoId` makes the enqueue idempotent. */
@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueue(videoId: string): Promise<void> {
    const data: VideoProcessJobData = { videoId };
    await this.queue.add(VIDEO_PROCESS_JOB, data, {
      ...VIDEO_PROCESS_JOB_OPTIONS,
      jobId: videoId,
    });
  }
}
