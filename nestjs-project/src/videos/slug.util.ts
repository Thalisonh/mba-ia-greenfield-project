import { randomInt } from 'node:crypto';

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const VIDEO_SLUG_LENGTH = 11;

/** Short, URL-safe and non-enumerable public identifier of a video (TD-11). */
export function generateVideoSlug(): string {
  let slug = '';
  for (let i = 0; i < VIDEO_SLUG_LENGTH; i++) {
    slug += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  }
  return slug;
}
