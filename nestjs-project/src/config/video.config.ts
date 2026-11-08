import { registerAs } from '@nestjs/config';

export const DEFAULT_VIDEO_MAX_UPLOAD_BYTES = 10 * 1024 ** 3; // 10 GiB
export const DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES = 64 * 1024 ** 2; // 64 MiB
export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 ** 2; // 5 MiB (S3 multipart minimum)

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES ?? `${DEFAULT_VIDEO_MAX_UPLOAD_BYTES}`,
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES ??
      `${DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES}`,
    10,
  ),
  presignExpiresSeconds: parseInt(
    process.env.VIDEO_PRESIGN_EXPIRES_SECONDS ?? '3600',
    10,
  ),
}));
