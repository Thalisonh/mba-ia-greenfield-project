import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';
import { parseRange } from './range.util';

describe('parseRange', () => {
  it('should return undefined without a header', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
  });

  it.each([
    ['closed range', 'bytes=0-9', { start: 0, end: 9 }],
    ['open-ended range', 'bytes=90-', { start: 90, end: 99 }],
    ['suffix range', 'bytes=-10', { start: 90, end: 99 }],
    ['suffix larger than the file', 'bytes=-500', { start: 0, end: 99 }],
    ['end clamped to the last byte', 'bytes=50-5000', { start: 50, end: 99 }],
    ['single last byte', 'bytes=99-99', { start: 99, end: 99 }],
  ])('should parse a %s', (_name, header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });

  it.each([
    ['start at the size', 'bytes=100-'],
    ['start after end', 'bytes=10-5'],
    ['multiple ranges', 'bytes=0-1,5-6'],
    ['another unit', 'items=0-1'],
    ['garbage', 'bytes=abc'],
    ['empty bounds', 'bytes=-'],
    ['zero-length suffix', 'bytes=-0'],
  ])('should reject %s', (_name, header) => {
    expect(() => parseRange(header, 100)).toThrow(RangeNotSatisfiableException);
  });

  it('should reject any range on an empty object', () => {
    expect(() => parseRange('bytes=0-', 0)).toThrow(
      RangeNotSatisfiableException,
    );
  });

  it('should expose the size through the Content-Range header', () => {
    expect.assertions(1);
    try {
      parseRange('bytes=100-', 100);
    } catch (error) {
      expect((error as RangeNotSatisfiableException).headers).toEqual({
        'Content-Range': 'bytes */100',
      });
    }
  });
});
