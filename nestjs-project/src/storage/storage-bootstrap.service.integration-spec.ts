import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  DeleteBucketLifecycleCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import {
  S3_INTERNAL_CLIENT,
  STORAGE_LIFECYCLE_RULE_ID,
} from './storage.constants';
import { StorageBootstrapService } from './storage-bootstrap.service';
import { StorageModule } from './storage.module';

describe('StorageBootstrapService (integration)', () => {
  let module: TestingModule;
  let bootstrap: StorageBootstrapService;
  let client: S3Client;
  const Bucket = process.env.S3_BUCKET ?? 'streamtube';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    bootstrap = module.get(StorageBootstrapService);
    client = module.get<S3Client>(S3_INTERNAL_CLIENT);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should be idempotent and leave the bucket in place', async () => {
    await bootstrap.ensureBucket();
    await expect(bootstrap.ensureBucket()).resolves.toBeUndefined();

    await expect(
      client.send(new HeadBucketCommand({ Bucket })),
    ).resolves.toBeDefined();
  });

  it('should leave either the AbortIncompleteMultipartUpload rule or no lifecycle (MinIO server-side expiry)', async () => {
    await client.send(new DeleteBucketLifecycleCommand({ Bucket }));

    await bootstrap.ensureBucket();

    const rules = await client
      .send(new GetBucketLifecycleConfigurationCommand({ Bucket }))
      .then((r) => r.Rules ?? [])
      .catch((error: { name?: string }) => {
        if (error.name === 'NoSuchLifecycleConfiguration') return [];
        throw error;
      });
    for (const rule of rules) {
      expect(rule.ID).toBe(STORAGE_LIFECYCLE_RULE_ID);
      expect(rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(1);
    }
  });

  it('should let the frontend origin read the ETag header (bucket or server-level CORS)', async () => {
    await bootstrap.ensureBucket();
    const origin = (
      process.env.S3_CORS_ALLOWED_ORIGINS ?? 'http://localhost:3001'
    ).split(',')[0];
    const endpoint = process.env.S3_ENDPOINT ?? 'http://minio:9000';

    const preflight = await fetch(`${endpoint}/${Bucket}/videos/cors-probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
      },
    });

    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(
      /PUT/,
    );

    const response = await fetch(`${endpoint}/${Bucket}/videos/cors-probe`, {
      headers: { Origin: origin },
    });
    expect(
      (
        response.headers.get('access-control-expose-headers') ?? ''
      ).toLowerCase(),
    ).toContain('etag');
  });
});
