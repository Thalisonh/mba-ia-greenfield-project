import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  NewVideo,
  ReadyVideoData,
  VideosRepository,
} from './videos.repository';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_CONSTRAINT_HINT = 'slug';
const MAX_SLUG_ATTEMPTS = 5;

function isSlugCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  // QueryFailedError copies the pg driver fields (code, detail) onto itself.
  const { code, detail } = error as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(SLUG_CONSTRAINT_HINT)
  );
}

/** Owns the video lifecycle: draft creation, lookups and status transitions. */
@Injectable()
export class VideosService {
  constructor(private readonly videosRepository: VideosRepository) {}

  async createDraft(input: Omit<NewVideo, 'slug'>): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.videosRepository.insert({
          ...input,
          slug: generateVideoSlug(),
        });
        return await this.getById(input.id);
      } catch (error) {
        if (!isSlugCollision(error) || attempt >= MAX_SLUG_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  async getById(id: string): Promise<Video> {
    const video = await this.videosRepository.findById(id);
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async findOwnedById(id: string, userId: string): Promise<Video> {
    const video = await this.videosRepository.findByIdAndOwner(id, userId);
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async findReadyBySlug(slug: string): Promise<Video> {
    const video = await this.videosRepository.findReadyBySlug(slug);
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async markProcessing(id: string, sizeBytes: number): Promise<void> {
    await this.videosRepository.markProcessing(id, sizeBytes);
  }

  async markReady(id: string, data: ReadyVideoData): Promise<void> {
    await this.videosRepository.markReady(id, data);
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.videosRepository.markFailed(id, message);
  }

  async remove(id: string): Promise<void> {
    await this.videosRepository.remove(id);
  }
}
