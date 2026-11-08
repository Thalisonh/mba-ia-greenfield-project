/** S3 client used for server-side I/O against the internal endpoint (S3_ENDPOINT). */
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');

/**
 * S3 client configured with the browser-facing endpoint (S3_PUBLIC_ENDPOINT).
 * Only used to sign URLs — signing is offline, so it never opens a connection.
 */
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const STORAGE_LIFECYCLE_RULE_ID = 'abort-incomplete-video-uploads';
export const STORAGE_VIDEOS_PREFIX = 'videos/';
