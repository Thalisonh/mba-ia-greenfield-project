import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartRangeException,
  UploadIncompleteException,
  VideoFileTooLargeException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { toVideoResponse, VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadSessionDto } from './dto/video-upload-session.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosService } from './videos.service';

const MAX_PARTS_PER_BATCH = 100;
const MAX_TITLE_LENGTH = 100;
const STORAGE_PART_REJECTIONS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

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
    private readonly producer: VideoProcessingProducer,
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

  async complete(
    userId: string,
    id: string,
    dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.findUploadableVideo(userId, id);
    this.assertAllPartsPresent(video, dto);
    await this.completeOnStorage(video, dto);

    const { contentLength } = await this.storageService.headObject(
      video.storage_key,
    );
    // Presigned parts cannot enforce a size, so the declared one is not proof.
    if (contentLength > this.config.maxUploadBytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videosService.markFailed(
        id,
        'Uploaded file exceeds the maximum allowed size',
      );
      throw new VideoFileTooLargeException();
    }

    await this.videosService.markProcessing(id, contentLength);
    try {
      await this.producer.enqueue(id);
    } catch (error) {
      // Without a job nothing would ever move the video out of `processing`.
      await this.videosService.markFailed(
        id,
        'Could not enqueue the video for processing',
      );
      throw error;
    }

    return toVideoResponse(await this.videosService.getById(id));
  }

  async cancel(userId: string, id: string): Promise<void> {
    const video = await this.findUploadableVideo(userId, id);
    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id as string,
    );
    await this.videosService.remove(id);
  }

  private assertAllPartsPresent(video: Video, dto: CompleteUploadDto): void {
    const partCount = this.partCount(video);
    const numbers = new Set(dto.parts.map((part) => part.part_number));
    const complete =
      dto.parts.length === partCount &&
      numbers.size === partCount &&
      [...numbers].every((number) => number <= partCount);
    if (!complete) throw new UploadIncompleteException();
  }

  private async completeOnStorage(
    video: Video,
    dto: CompleteUploadDto,
  ): Promise<void> {
    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        STORAGE_PART_REJECTIONS.has(error.name)
      ) {
        throw new UploadIncompleteException();
      }
      throw error;
    }
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
