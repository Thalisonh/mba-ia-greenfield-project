import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageBootstrapService } from '../storage/storage-bootstrap.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { generateTestVideo } from '../test/video-fixture';
import { FfmpegService, InvalidMediaError } from './ffmpeg.service';

describe('FfmpegService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const ffmpeg = new FfmpegService();
  const keys: string[] = [];

  const store = async (content: Buffer, type = 'video/mp4') => {
    const key = `videos/test-${randomUUID()}/original`;
    keys.push(key);
    await storage.putObject(key, content, type);
    return storage.presignInternalGetObject(key, 600);
  };

  beforeAll(async () => {
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
    for (const key of keys) await storage.deleteObject(key);
    await module.close();
  });

  it('should probe duration and metadata through a presigned URL', async () => {
    const url = await store(await generateTestVideo(2));

    const result = await ffmpeg.probe(url);

    expect(result.hasVideoStream).toBe(true);
    expect(result.durationSeconds).toBeGreaterThan(1.9);
    expect(result.durationSeconds).toBeLessThan(2.1);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: null,
      frameRate: 25,
    });
  });

  it('should extract a JPEG thumbnail', async () => {
    const url = await store(await generateTestVideo(2));

    const jpeg = await ffmpeg.extractThumbnail(url, 0.2);

    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('should fail with the ffprobe output for bytes that are not a video', async () => {
    const url = await store(randomBytes(4096));

    await expect(ffmpeg.probe(url)).rejects.toThrow(/ffprobe exited with code/);
    await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('should refuse a valid media file whose container is outside the whitelist', async () => {
    const samples = Buffer.alloc(1600);
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + samples.length, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(samples.length, 40);
    const url = await store(Buffer.concat([wav, samples]));

    await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('should not leak the signed URL in the error message', async () => {
    const url = await store(randomBytes(4096));

    const error = await ffmpeg.probe(url).catch((e: Error) => e);

    expect((error as Error).message).not.toContain('X-Amz-Signature');
  });
});
