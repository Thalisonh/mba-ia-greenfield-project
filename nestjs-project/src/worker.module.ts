import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';

/** Root module of the `video-worker` process: no HTTP layer, only job consumers. */
@Module({
  imports: [AppConfigModule, DatabaseModule, QueueModule],
})
export class WorkerModule {}
