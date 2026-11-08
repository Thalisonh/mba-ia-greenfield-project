import { generateVideoSlug, VIDEO_SLUG_LENGTH } from './slug.util';

describe('generateVideoSlug', () => {
  it('should generate 11 base62 characters', () => {
    expect(VIDEO_SLUG_LENGTH).toBe(11);
    expect(generateVideoSlug()).toMatch(/^[0-9A-Za-z]{11}$/);
  });

  it('should not repeat across many generations', () => {
    const slugs = new Set(
      Array.from({ length: 10000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(10000);
  });
});
