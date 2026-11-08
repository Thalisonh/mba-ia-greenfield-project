import { Matches } from 'class-validator';

export class VideoSlugParamDto {
  /** Public 11-character identifier of the video. */
  @Matches(/^[0-9A-Za-z]{11}$/)
  slug: string;
}
