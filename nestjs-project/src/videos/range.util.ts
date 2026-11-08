import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';
import type { ByteRange } from '../storage/storage.service';

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a `Range` header against the object size. Returns `undefined` when
 * there is no header. Only single ranges are supported (TD-12).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | undefined {
  if (header === undefined) return undefined;

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    throw new RangeNotSatisfiableException(size);
  }

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) throw new RangeNotSatisfiableException(size);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (size === 0 || start >= size || start > end) {
    throw new RangeNotSatisfiableException(size);
  }
  return { start, end };
}
