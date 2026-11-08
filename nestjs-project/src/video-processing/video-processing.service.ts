import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import {
  FfmpegService,
  InvalidMediaError,
  ProbeResult,
} from './ffmpeg.service';

const THUMBNAIL_POSITION = 0.1;
const MIN_DURATION_FOR_SEEK_SECONDS = 1;
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** Extracts metadata and the thumbnail, then moves the video to `ready` (TD-06). */
@Injectable()
export class VideoProcessingService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videosService.findById(videoId);
    // At-least-once delivery: a redelivered or orphaned job must be a no-op.
    if (!video || video.status !== VideoStatus.PROCESSING) return;

    const url = await this.storageService.presignInternalGetObject(
      video.storage_key,
      this.config.presignExpiresSeconds,
    );

    try {
      const probe = await this.ffmpegService.probe(url);
      const durationSeconds = this.assertPlayable(probe);
      const thumbnail = await this.ffmpegService.extractThumbnail(
        url,
        durationSeconds < MIN_DURATION_FOR_SEEK_SECONDS
          ? 0
          : durationSeconds * THUMBNAIL_POSITION,
      );

      const thumbnailKey = `videos/${videoId}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        THUMBNAIL_CONTENT_TYPE,
      );
      await this.videosService.markReady(videoId, {
        durationSeconds,
        metadata: probe.metadata,
        thumbnailKey,
      });
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  async markFailed(videoId: string, message: string): Promise<void> {
    await this.videosService.markFailed(videoId, message);
  }

  private assertPlayable(probe: ProbeResult): number {
    if (!probe.hasVideoStream) {
      throw new UnrecoverableError('The file has no video stream');
    }
    if (probe.durationSeconds === null) {
      throw new UnrecoverableError('The file has no readable duration');
    }
    return probe.durationSeconds;
  }
}
