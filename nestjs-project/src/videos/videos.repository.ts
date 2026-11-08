import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video, VideoMetadata, VideoStatus } from './entities/video.entity';

export type NewVideo = Pick<
  Video,
  | 'id'
  | 'channel_id'
  | 'slug'
  | 'title'
  | 'original_filename'
  | 'content_type'
  | 'size_bytes'
  | 'storage_key'
  | 'upload_id'
>;

export interface ReadyVideoData {
  durationSeconds: number;
  metadata: VideoMetadata;
  thumbnailKey: string;
}

/** Encapsulates every query against the `videos` table. */
@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video) private readonly repository: Repository<Video>,
  ) {}

  /** Plain INSERT so a slug collision surfaces as a 23505 instead of an upsert. */
  async insert(video: NewVideo): Promise<void> {
    await this.repository.insert(video);
  }

  async findById(id: string): Promise<Video | null> {
    return this.repository.findOne({ where: { id } });
  }

  async findByIdAndOwner(id: string, userId: string): Promise<Video | null> {
    return this.repository.findOne({
      where: { id, channel: { user_id: userId } },
    });
  }

  async findReadyBySlug(slug: string): Promise<Video | null> {
    return this.repository.findOne({
      where: { slug, status: VideoStatus.READY },
    });
  }

  async markProcessing(id: string, sizeBytes: number): Promise<void> {
    await this.repository.update(id, {
      status: VideoStatus.PROCESSING,
      size_bytes: sizeBytes,
      upload_id: null,
    });
  }

  async markReady(id: string, data: ReadyVideoData): Promise<void> {
    await this.repository.update(id, {
      status: VideoStatus.READY,
      duration_seconds: data.durationSeconds,
      metadata: data.metadata,
      thumbnail_key: data.thumbnailKey,
      processing_error: null,
    });
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.repository.update(id, {
      status: VideoStatus.FAILED,
      processing_error: message,
      upload_id: null,
    });
  }

  async remove(id: string): Promise<void> {
    await this.repository.delete(id);
  }
}
