/**
 * Presigned URLs are signed for S3_PUBLIC_ENDPOINT (the browser-facing host,
 * `localhost:9000` in development). Tests run inside the `nestjs-api`
 * container, where only the Compose service name resolves — so they sign for
 * the internal host instead. Call before the testing module is compiled (config
 * factories read `process.env` at load time).
 */
export function useInternalHostForPresignedUrls(): void {
  process.env.S3_PUBLIC_ENDPOINT =
    process.env.S3_ENDPOINT ?? 'http://minio:9000';
}

export async function putToPresignedUrl(
  url: string,
  body: Buffer,
): Promise<Response> {
  return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
}
