import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

/** Root module of the `video-worker` process: no HTTP layer, only job consumers. */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
