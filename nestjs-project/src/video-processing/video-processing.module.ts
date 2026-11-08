import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideosModule } from '../videos/videos.module';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

/** UsersModule is here for its entity: Video → Channel → User metadata. */
@Module({
  imports: [
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    VideosModule,
    StorageModule,
    UsersModule,
  ],
  providers: [FfmpegService, VideoProcessingService, VideoProcessor],
})
export class VideoProcessingModule {}
