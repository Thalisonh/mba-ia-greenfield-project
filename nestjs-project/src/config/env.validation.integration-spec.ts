import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string>, omit: string[] = []) => {
  const merged: Record<string, string> = { ...requiredEnv, ...env };
  for (const key of omit) delete merged[key];
  return envValidationSchema.validate(merged, {
    allowUnknown: true,
    abortEarly: false,
  });
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video upload policy', () => {
  it('should reject a missing S3_ACCESS_KEY_ID', () => {
    const { error } = validate({}, ['S3_ACCESS_KEY_ID']);
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
  });

  it('should reject a missing S3_SECRET_ACCESS_KEY', () => {
    const { error } = validate({}, ['S3_SECRET_ACCESS_KEY']);
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('should default hosts to the Compose service names and the upload policy to 10 GiB / 64 MiB / 1h', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.VIDEO_MAX_UPLOAD_BYTES).toBe(10737418240);
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.VIDEO_PRESIGN_EXPIRES_SECONDS).toBe(3600);
  });

  it('should reject a part size below the 5 MiB S3 multipart minimum', () => {
    const { error } = validate({
      VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject an invalid S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});
