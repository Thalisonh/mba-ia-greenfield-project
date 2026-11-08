import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartsQueryDto } from './dto/upload-parts-query.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadSessionDto } from './dto/video-upload-session.dto';
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
  constructor(private readonly videoUploadsService: VideoUploadsService) {}

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
}
