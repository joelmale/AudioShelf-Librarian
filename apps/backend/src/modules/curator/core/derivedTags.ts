/**
 * Deterministic tags derived from book metadata rather than asked of the LLM.
 *
 * `length` (from duration) and `era` (from published year) are pure functions
 * of fields the sync already has — asking an LLM to guess them wastes tokens
 * and is strictly less reliable than computing them. `deriveTags` always
 * returns confidence 1 and `source: 'derived'`; tagger.ts merges these ahead
 * of LLM output and lets them win over any LLM tag in the same category.
 */
import type { Book, GeneratedTag } from './types.js';

const HOUR = 3600;

function deriveLength(durationSeconds: number | null): string | null {
  if (durationSeconds === null) return null;
  if (durationSeconds < 6 * HOUR) return 'short';
  if (durationSeconds < 12 * HOUR) return 'medium';
  if (durationSeconds <= 20 * HOUR) return 'long';
  return 'epic';
}

function deriveEra(publishedYear: number | null): string | null {
  if (publishedYear === null) return null;
  if (publishedYear <= 1959) return 'golden-age';
  if (publishedYear <= 1979) return 'new-wave';
  if (publishedYear <= 1999) return 'classic';
  return 'modern';
}

export function deriveTags(book: Book): Array<GeneratedTag & { source: 'derived' }> {
  const tags: Array<GeneratedTag & { source: 'derived' }> = [];

  const length = deriveLength(book.durationSeconds);
  if (length !== null) {
    tags.push({ tag: length, category: 'length', confidence: 1, source: 'derived' });
  }

  const era = deriveEra(book.publishedYear);
  if (era !== null) {
    tags.push({ tag: era, category: 'era', confidence: 1, source: 'derived' });
  }

  return tags;
}
