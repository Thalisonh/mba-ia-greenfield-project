import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { VideoProcessJobData } from '../videos/video-processing.producer';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';

/** Consumes `video.process` in the worker process only (TD-05). */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    await this.processingService.process(job.data.videoId);
  }

  /** Only a terminal failure reaches the database; others are retried (TD-10). */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!(error instanceof UnrecoverableError) && !isFinalAttempt) return;

    try {
      await this.processingService.markFailed(job.data.videoId, error.message);
    } catch (markError) {
      // Background handler: rethrowing here would crash the worker.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
  }
}
