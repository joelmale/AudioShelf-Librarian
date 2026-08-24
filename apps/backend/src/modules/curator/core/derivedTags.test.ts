import { describe, expect, it } from 'vitest';

import { deriveTags, EXCLUSIVE_DERIVED_CATEGORIES } from './derivedTags.js';
import type { Book } from './types.js';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    title: 'Some Book',
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    ...overrides,
  };
}

const HOUR = 3600;

describe('deriveTags', () => {
  describe('length buckets', () => {
    it('tags just under 6h as short', () => {
      const tags = deriveTags(makeBook({ durationSeconds: 5.9 * HOUR }));
      expect(tags).toContainEqual({ tag: 'short', category: 'length', confidence: 1, source: 'derived' });
    });

    it('tags exactly 6h as medium (lower bound inclusive)', () => {
      const tags = deriveTags(makeBook({ durationSeconds: 6 * HOUR }));
      expect(tags).toContainEqual({ tag: 'medium', category: 'length', confidence: 1, source: 'derived' });
    });

    it('tags exactly 12h as long (medium upper bound exclusive)', () => {
      const tags = deriveTags(makeBook({ durationSeconds: 12 * HOUR }));
      expect(tags).toContainEqual({ tag: 'long', category: 'length', confidence: 1, source: 'derived' });
    });

    it('tags exactly 20h as long (inclusive upper bound)', () => {
      const tags = deriveTags(makeBook({ durationSeconds: 20 * HOUR }));
      expect(tags).toContainEqual({ tag: 'long', category: 'length', confidence: 1, source: 'derived' });
    });

    it('tags just over 20h as epic', () => {
      const tags = deriveTags(makeBook({ durationSeconds: 20.1 * HOUR }));
      expect(tags).toContainEqual({ tag: 'epic', category: 'length', confidence: 1, source: 'derived' });
    });

    it('omits the length tag when duration is null', () => {
      const tags = deriveTags(makeBook({ durationSeconds: null }));
      expect(tags.find((t) => t.category === 'length')).toBeUndefined();
    });
  });

  describe('era buckets', () => {
    it('tags 1959 as golden-age (upper bound inclusive)', () => {
      const tags = deriveTags(makeBook({ publishedYear: 1959 }));
      expect(tags).toContainEqual({ tag: 'golden-age', category: 'era', confidence: 1, source: 'derived' });
    });

    it('tags 1960 as new-wave (lower bound inclusive)', () => {
      const tags = deriveTags(makeBook({ publishedYear: 1960 }));
      expect(tags).toContainEqual({ tag: 'new-wave', category: 'era', confidence: 1, source: 'derived' });
    });

    it('tags 1979 as new-wave (upper bound inclusive)', () => {
      const tags = deriveTags(makeBook({ publishedYear: 1979 }));
      expect(tags).toContainEqual({ tag: 'new-wave', category: 'era', confidence: 1, source: 'derived' });
    });

    it('tags 1980 as classic (lower bound inclusive)', () => {
      const tags = deriveTags(makeBook({ publishedYear: 1980 }));
      expect(tags).toContainEqual({ tag: 'classic', category: 'era', confidence: 1, source: 'derived' });
    });

    it('tags 1999 as classic (upper bound inclusive)', () => {
      const tags = deriveTags(makeBook({ publishedYear: 1999 }));
      expect(tags).toContainEqual({ tag: 'classic', category: 'era', confidence: 1, source: 'derived' });
    });

    it('tags 2000 as modern (lower bound inclusive)', () => {
      const tags = deriveTags(makeBook({ publishedYear: 2000 }));
      expect(tags).toContainEqual({ tag: 'modern', category: 'era', confidence: 1, source: 'derived' });
    });

    it('omits the era tag when publishedYear is null', () => {
      const tags = deriveTags(makeBook({ publishedYear: null }));
      expect(tags.find((t) => t.category === 'era')).toBeUndefined();
    });
  });

  it('returns both tags with confidence 1 and source derived when both fields are present', () => {
    const tags = deriveTags(makeBook({ durationSeconds: 8 * HOUR, publishedYear: 1985 }));
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      expect(tag.confidence).toBe(1);
      expect(tag.source).toBe('derived');
    }
  });

  it('returns an empty array when both fields are null', () => {
    expect(deriveTags(makeBook())).toEqual([]);
  });

  /**
   * The publisher stamps the production format into the title, so this is a
   * string match rather than a judgement call. The LLM found 3 of these across
   * the whole library; the markers find every one.
   */
  describe('full-cast', () => {
    const fullCast = (title: string) => deriveTags(makeBook({ title })).find((t) => t.tag === 'full-cast');

    it.each([
      'Amazon Gate Full Cast (GraphicAudio)',
      'Crater Lake Full Cast (GraphicAudio)',
      'Watersleep [Dramatized Adaptation]',
      'Immortalis (Dramatized Adaptation)',
      'Some Title (GraphicAudio)',
      'A Dramatised Adaptation',
    ])('tags %s as full-cast', (title) => {
      expect(fullCast(title)).toEqual({
        tag: 'full-cast',
        category: 'structure',
        confidence: 1,
        source: 'derived',
      });
    });

    it.each(['Snow Crash', 'The Stand', 'A Full Life', 'Casting Off'])('leaves %s alone', (title) => {
      expect(fullCast(title)).toBeUndefined();
    });

    it('lands in structure, which is NOT an exclusive derived category', () => {
      expect(EXCLUSIVE_DERIVED_CATEGORIES.has('structure')).toBe(false);
      expect(EXCLUSIVE_DERIVED_CATEGORIES.has('length')).toBe(true);
      expect(EXCLUSIVE_DERIVED_CATEGORIES.has('era')).toBe(true);
    });
  });
});
