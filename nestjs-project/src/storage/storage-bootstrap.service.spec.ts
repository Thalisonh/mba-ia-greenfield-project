import { Test } from '@nestjs/testing';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageBootstrapService } from './storage-bootstrap.service';

function s3Error(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
    message: name,
  });
}

describe('StorageBootstrapService', () => {
  const send = jest.fn();

  async function build(): Promise<StorageBootstrapService> {
    const module = await Test.createTestingModule({
      providers: [
        StorageBootstrapService,
        { provide: S3_INTERNAL_CLIENT, useValue: { send } },
        {
          provide: storageConfig.KEY,
          useValue: { bucket: 'b', corsAllowedOrigins: ['http://front'] },
        },
      ],
    }).compile();
    return module.get(StorageBootstrapService);
  }

  beforeEach(() => send.mockReset());

  it('should create the bucket when HeadBucket returns 404', async () => {
    send.mockImplementation((command: unknown) =>
      command instanceof HeadBucketCommand
        ? Promise.reject(s3Error('NotFound', 404))
        : Promise.resolve({}),
    );
    const service = await build();

    await service.ensureBucket();

    expect(
      send.mock.calls.some(([c]) => c instanceof CreateBucketCommand),
    ).toBe(true);
  });

  it('should tolerate storages without bucket CORS and lifecycle-abort support (MinIO)', async () => {
    send.mockImplementation((command: unknown) => {
      if (command instanceof PutBucketCorsCommand)
        return Promise.reject(s3Error('NotImplemented', 501));
      if (command instanceof PutBucketLifecycleConfigurationCommand)
        return Promise.reject(s3Error('InvalidArgument', 400));
      return Promise.resolve({});
    });
    const service = await build();

    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('should propagate unexpected storage errors', async () => {
    send.mockImplementation((command: unknown) =>
      command instanceof PutBucketLifecycleConfigurationCommand
        ? Promise.reject(s3Error('AccessDenied', 403))
        : Promise.resolve({}),
    );
    const service = await build();

    await expect(service.ensureBucket()).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });

  it('should send the AbortIncompleteMultipartUpload rule for the videos/ prefix', async () => {
    send.mockResolvedValue({});
    const service = await build();

    await service.ensureBucket();

    const lifecycle = send.mock.calls
      .map(([c]) => c as unknown)
      .find(
        (c): c is PutBucketLifecycleConfigurationCommand =>
          c instanceof PutBucketLifecycleConfigurationCommand,
      );
    expect(lifecycle?.input.LifecycleConfiguration?.Rules?.[0]).toMatchObject({
      Filter: { Prefix: 'videos/' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    });
  });
});
