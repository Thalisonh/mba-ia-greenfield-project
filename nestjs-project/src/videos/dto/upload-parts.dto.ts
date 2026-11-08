import { ApiProperty } from '@nestjs/swagger';

export class PresignedPartDto {
  @ApiProperty()
  part_number: number;

  @ApiProperty({ description: 'Presigned URL; PUT the part bytes to it.' })
  url: string;
}

export class UploadedPartDto {
  @ApiProperty()
  part_number: number;

  @ApiProperty()
  etag: string;

  @ApiProperty()
  size: number;
}

export class UploadPartsDto {
  @ApiProperty()
  part_size: number;

  @ApiProperty()
  part_count: number;

  @ApiProperty()
  expires_in_seconds: number;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
