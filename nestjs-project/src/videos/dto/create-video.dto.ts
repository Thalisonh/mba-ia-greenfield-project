import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  /** Original file name, including the extension. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** MIME type of the file; must be a `video/*` type. */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/)
  content_type: string;

  /** File size in bytes. */
  @IsInt()
  @Min(1)
  size: number;

  /** Video title. Defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title?: string;
}
