import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartRangeException,
  VideoFileTooLargeException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { toVideoResponse, VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadSessionDto } from './dto/video-upload-session.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const MAX_PARTS_PER_BATCH = 100;
const MAX_TITLE_LENGTH = 100;

function defaultTitle(filename: string): string {
  return parse(filename).name.slice(0, MAX_TITLE_LENGTH);
}

/** Drives the direct-to-storage multipart upload handshake (TD-07, TD-08). */
@Injectable()
export class VideoUploadsService {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initiate(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<VideoUploadSessionDto> {
    if (dto.size > this.config.maxUploadBytes) {
      throw new VideoFileTooLargeException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const id = randomUUID();
    const storageKey = `videos/${id}/original`;
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.videosService.createDraft({
        id,
        channel_id: channel.id,
        title: dto.title ?? defaultTitle(dto.filename),
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: dto.size,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (error) {
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw error;
    }

    return {
      video: toVideoResponse(video),
      upload: {
        part_size: this.config.uploadPartSizeBytes,
        part_count: this.partCount(video),
        expires_in_seconds: this.config.presignExpiresSeconds,
      },
    };
  }

  async getVideo(userId: string, id: string): Promise<VideoResponseDto> {
    return toVideoResponse(await this.videosService.findOwnedById(id, userId));
  }

  async getPartUrls(
    userId: string,
    id: string,
    from: number,
    to: number,
  ): Promise<UploadPartsDto> {
    const video = await this.findUploadableVideo(userId, id);
    const partCount = this.partCount(video);
    if (to < from || to - from + 1 > MAX_PARTS_PER_BATCH || to > partCount) {
      throw new InvalidPartRangeException();
    }

    const uploadId = video.upload_id as string;
    const expiresIn = this.config.presignExpiresSeconds;
    const partNumbers = Array.from(
      { length: to - from + 1 },
      (_, index) => from + index,
    );
    const [parts, uploaded] = await Promise.all([
      Promise.all(
        partNumbers.map(async (partNumber) => ({
          part_number: partNumber,
          url: await this.storageService.presignUploadPart(
            video.storage_key,
            uploadId,
            partNumber,
            expiresIn,
          ),
        })),
      ),
      this.storageService.listParts(video.storage_key, uploadId),
    ]);

    return {
      part_size: this.config.uploadPartSizeBytes,
      part_count: partCount,
      expires_in_seconds: expiresIn,
      parts,
      uploaded_parts: uploaded.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size: part.size,
      })),
    };
  }

  private async findUploadableVideo(
    userId: string,
    id: string,
  ): Promise<Video> {
    const video = await this.videosService.findOwnedById(id, userId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotUploadableException();
    }
    return video;
  }

  private partCount(video: Video): number {
    return Math.ceil(video.size_bytes / this.config.uploadPartSizeBytes);
  }
}
