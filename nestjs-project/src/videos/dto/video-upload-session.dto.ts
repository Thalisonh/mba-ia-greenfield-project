import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPolicyDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({ example: 3600 })
  expires_in_seconds: number;
}

export class VideoUploadSessionDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadPolicyDto })
  upload: UploadPolicyDto;
}
