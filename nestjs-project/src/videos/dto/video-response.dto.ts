import { ApiProperty } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ nullable: true, type: Number })
  width: number | null;

  @ApiProperty({ nullable: true, type: Number })
  height: number | null;

  @ApiProperty({ nullable: true, type: String })
  videoCodec: string | null;

  @ApiProperty({ nullable: true, type: String })
  audioCodec: string | null;

  @ApiProperty({ nullable: true, type: String })
  formatName: string | null;

  @ApiProperty({ nullable: true, type: Number })
  bitRate: number | null;

  @ApiProperty({ nullable: true, type: Number })
  frameRate: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ09bY18cX2' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty()
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty({ nullable: true, type: Number })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, type: VideoMetadataDto })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ nullable: true, type: String })
  processing_error: string | null;

  @ApiProperty({ example: '/videos/aZ09bY18cX2/stream' })
  stream_url: string;

  @ApiProperty({ example: '/videos/aZ09bY18cX2/download' })
  download_url: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '/videos/aZ09bY18cX2/thumbnail',
  })
  thumbnail_url: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updated_at: Date;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    status: video.status,
    original_filename: video.original_filename,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    metadata: video.metadata,
    processing_error: video.processing_error,
    stream_url: `/videos/${video.slug}/stream`,
    download_url: `/videos/${video.slug}/download`,
    thumbnail_url: video.thumbnail_key
      ? `/videos/${video.slug}/thumbnail`
      : null,
    created_at: video.created_at,
    updated_at: video.updated_at,
  };
}
