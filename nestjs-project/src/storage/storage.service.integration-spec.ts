import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import {
  putToPresignedUrl,
  useInternalHostForPresignedUrls,
} from '../test/storage';
import { StorageBootstrapService } from './storage-bootstrap.service';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    useInternalHostForPresignedUrls();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    await module.get(StorageBootstrapService).ensureBucket();
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await module.close();
  });

  const newKey = () => {
    const key = `videos/test-${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  it('should accept a plain PUT on a presigned UploadPart URL and return an ETag', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 600);

    const response = await putToPresignedUrl(url, randomBytes(1024));

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('should assemble a two-part multipart upload and list the uploaded parts', async () => {
    const key = newKey();
    const first = randomBytes(5 * MIB);
    const second = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const etags: string[] = [];
    for (const [index, chunk] of [first, second].entries()) {
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        index + 1,
        600,
      );
      const response = await putToPresignedUrl(url, chunk);
      etags.push(response.headers.get('etag') as string);
    }

    const listed = await storage.listParts(key, uploadId);
    expect(listed.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(listed.map((p) => p.size)).toEqual([5 * MIB, 1024]);

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etags[1] },
      { partNumber: 1, etag: etags[0] },
    ]);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(5 * MIB + 1024);
    expect(head.contentType).toBe('video/mp4');
  });

  it('should return exactly the requested byte range', async () => {
    const key = newKey();
    const content = randomBytes(4096);
    await storage.putObject(key, content, 'video/mp4');

    const object = await storage.getObjectStream(key, { start: 0, end: 9 });
    const bytes = await readAll(object.body);

    expect(bytes.equals(content.subarray(0, 10))).toBe(true);
    expect(object.contentLength).toBe(10);
    expect(object.contentRange).toBe('bytes 0-9/4096');
  });

  it('should stream the whole object when no range is given', async () => {
    const key = newKey();
    const content = randomBytes(2048);
    await storage.putObject(key, content, 'image/jpeg');

    const object = await storage.getObjectStream(key);

    expect((await readAll(object.body)).equals(content)).toBe(true);
    expect(object.contentType).toBe('image/jpeg');
  });

  it('should make an aborted upload unknown to ListParts', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('should serve a presigned internal GET URL', async () => {
    const key = newKey();
    const content = randomBytes(512);
    await storage.putObject(key, content, 'video/mp4');

    const url = await storage.presignInternalGetObject(key, 600);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(
      true,
    );
  });
});
