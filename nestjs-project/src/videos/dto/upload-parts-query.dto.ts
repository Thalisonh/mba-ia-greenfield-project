import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class UploadPartsQueryDto {
  /** First part number of the batch (1-based). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  from: number;

  /** Last part number of the batch (inclusive). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  to: number;
}
