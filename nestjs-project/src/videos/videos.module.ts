import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideoUploadsService } from './video-uploads.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosController } from './videos.controller';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    ChannelsModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [
    VideosRepository,
    VideosService,
    VideoUploadsService,
    VideoProcessingProducer,
    VideoDeliveryService,
  ],
  exports: [VideosService],
})
export class VideosModule {}
