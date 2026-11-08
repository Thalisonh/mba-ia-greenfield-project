import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import {
  S3_INTERNAL_CLIENT,
  STORAGE_LIFECYCLE_RULE_ID,
  STORAGE_VIDEOS_PREFIX,
} from './storage.constants';

/**
 * Idempotent bucket provisioning (TD-03, TD-14): bucket, CORS for direct
 * browser uploads (TD-07 revision ICC-1) and the lifecycle rule that purges
 * abandoned multipart uploads.
 */
@Injectable()
export class StorageBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageBootstrapService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;

    if (!(await this.bucketExists(Bucket))) {
      await this.client.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created bucket ${Bucket}`);
    }

    await this.applyCors(Bucket);
    await this.applyAbortIncompleteUploadsRule(Bucket);
  }

  /**
   * AWS S3 purges abandoned multipart uploads through this lifecycle rule.
   * MinIO rejects the action (`InvalidArgument`) because it purges stale
   * uploads server-side instead (MINIO_API_STALE_UPLOADS_EXPIRY in
   * compose.yaml, 24h) — same 1-day bound, different mechanism (TD-14).
   */
  private async applyAbortIncompleteUploadsRule(Bucket: string): Promise<void> {
    try {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: STORAGE_LIFECYCLE_RULE_ID,
                Status: 'Enabled',
                Filter: { Prefix: STORAGE_VIDEOS_PREFIX },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
              },
            ],
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        (error.name === 'InvalidArgument' || error.name === 'NotImplemented')
      ) {
        this.logger.warn(
          'Storage rejected the AbortIncompleteMultipartUpload lifecycle rule (MinIO); relying on server-side stale upload expiry (MINIO_API_STALE_UPLOADS_EXPIRY).',
        );
        return;
      }
      throw error;
    }
  }

  /**
   * AWS S3 supports per-bucket CORS. MinIO does not (`NotImplemented`): there
   * CORS is server-wide, configured by MINIO_API_CORS_ALLOW_ORIGIN in
   * compose.yaml. Either way the browser only gets CORS for the frontend origin.
   */
  private async applyCors(Bucket: string): Promise<void> {
    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: this.config.corsAllowedOrigins,
                AllowedMethods: ['PUT', 'GET', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.name === 'NotImplemented'
      ) {
        this.logger.warn(
          'Storage does not support bucket CORS (MinIO); relying on server-level CORS (MINIO_API_CORS_ALLOW_ORIGIN).',
        );
        return;
      }
      throw error;
    }
  }

  private async bucketExists(Bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
      return true;
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }
}
