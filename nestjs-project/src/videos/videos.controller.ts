import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartsQueryDto } from './dto/upload-parts-query.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoSlugParamDto } from './dto/video-slug-param.dto';
import { VideoUploadSessionDto } from './dto/video-upload-session.dto';
import {
  DeliverableMedia,
  VideoDeliveryService,
} from './video-delivery.service';
import { VideoUploadsService } from './video-uploads.service';

const ApiErrorResponse = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  });

// Playback and part-URL batches are chatty by design; the global 10 req/min
// limit exists for the auth endpoints (see DG-1 in the phase validation).
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videoUploadsService: VideoUploadsService,
    private readonly videoDeliveryService: VideoDeliveryService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Validates the upload policy, opens a multipart upload on the object storage and pre-registers the video as a draft. The file itself is sent directly to the storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload session opened',
    type: VideoUploadSessionDto,
  })
  @ApiErrorResponse(400, 'Validation failed or file too large')
  @ApiErrorResponse(401, 'Missing or invalid access token')
  @ApiErrorResponse(404, 'The authenticated user has no channel')
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoUploadSessionDto> {
    return this.videoUploadsService.initiate(user.sub, dto);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get one of your videos',
    description:
      'Returns a video owned by the authenticated user in any status — used to follow draft → processing → ready | failed.',
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiErrorResponse(400, 'The id is not a UUID')
  @ApiErrorResponse(401, 'Missing or invalid access token')
  @ApiErrorResponse(404, 'Video not found or owned by another channel')
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videoUploadsService.getVideo(user.sub, id);
  }

  @Get(':id/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned URLs for a range of upload parts',
    description:
      'Issues short-lived presigned URLs for up to 100 parts and lists the parts already received, which is how a client resumes an interrupted upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs and uploaded parts',
    type: UploadPartsDto,
  })
  @ApiErrorResponse(400, 'Invalid part range')
  @ApiErrorResponse(401, 'Missing or invalid access token')
  @ApiErrorResponse(404, 'Video not found or owned by another channel')
  @ApiErrorResponse(409, 'The video is not a draft')
  getUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UploadPartsQueryDto,
  ): Promise<UploadPartsDto> {
    return this.videoUploadsService.getPartUrls(
      user.sub,
      id,
      query.from,
      query.to,
    );
  }

  @Post(':id/upload/complete')
  @HttpCode(202)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts on the storage, moves the video to processing and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing was scheduled',
    type: VideoResponseDto,
  })
  @ApiErrorResponse(400, 'Invalid body, incomplete parts or file too large')
  @ApiErrorResponse(401, 'Missing or invalid access token')
  @ApiErrorResponse(404, 'Video not found or owned by another channel')
  @ApiErrorResponse(409, 'The video is not a draft')
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videoUploadsService.complete(user.sub, id, dto);
  }

  @Delete(':id/upload')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cancel a video upload',
    description:
      'Aborts the multipart upload, releasing the uploaded parts, and deletes the draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload cancelled' })
  @ApiErrorResponse(400, 'The id is not a UUID')
  @ApiErrorResponse(401, 'Missing or invalid access token')
  @ApiErrorResponse(404, 'Video not found or owned by another channel')
  @ApiErrorResponse(409, 'The video is not a draft')
  cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videoUploadsService.cancel(user.sub, id);
  }

  @Public()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Progressive playback of a ready video. Honors a single-range Range header with 206 Partial Content.',
  })
  @ApiHeader({ name: 'Range', required: false, example: 'bytes=0-1048575' })
  @ApiProduces('video/*')
  @ApiResponse({ status: 200, description: 'The whole file' })
  @ApiResponse({ status: 206, description: 'The requested byte range' })
  @ApiErrorResponse(400, 'Invalid slug')
  @ApiErrorResponse(404, 'Video not found or not ready')
  @ApiErrorResponse(416, 'The range cannot be satisfied')
  async stream(
    @Param() { slug }: VideoSlugParamDto,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.send(
      response,
      await this.videoDeliveryService.openMedia(slug, range, {
        attachment: false,
      }),
    );
  }

  @Public()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Sends the original file of a ready video as an attachment. Range requests allow resuming.',
  })
  @ApiHeader({ name: 'Range', required: false })
  @ApiProduces('video/*')
  @ApiResponse({ status: 200, description: 'The whole file' })
  @ApiResponse({ status: 206, description: 'The requested byte range' })
  @ApiErrorResponse(400, 'Invalid slug')
  @ApiErrorResponse(404, 'Video not found or not ready')
  @ApiErrorResponse(416, 'The range cannot be satisfied')
  async download(
    @Param() { slug }: VideoSlugParamDto,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.send(
      response,
      await this.videoDeliveryService.openMedia(slug, range, {
        attachment: true,
      }),
    );
  }

  @Public()
  @Get(':slug/thumbnail')
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description: 'Returns the JPEG thumbnail generated from the video.',
  })
  @ApiProduces('image/jpeg')
  @ApiResponse({ status: 200, description: 'The thumbnail' })
  @ApiErrorResponse(400, 'Invalid slug')
  @ApiErrorResponse(404, 'Video not found, not ready or without thumbnail')
  async thumbnail(
    @Param() { slug }: VideoSlugParamDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.send(
      response,
      await this.videoDeliveryService.openThumbnail(slug),
    );
  }

  private send(response: Response, media: DeliverableMedia): StreamableFile {
    response.status(media.statusCode).set(media.headers);
    // StreamableFile only pipes: without this, every player seek would leave
    // the storage connection open (S3 bodies must be consumed or destroyed).
    response.once('close', () => media.stream.destroy());
    return new StreamableFile(media.stream);
  }
}
