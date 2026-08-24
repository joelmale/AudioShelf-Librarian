/**
 * Deterministic tags derived from book metadata rather than asked of the LLM.
 *
 * `length` (from duration), `era` (from published year) and `full-cast` (from
 * production markers in the title) are pure functions of fields the sync
 * already has — asking an LLM to guess them wastes tokens and is strictly less
 * reliable than computing them. `deriveTags` always returns confidence 1 and
 * `source: 'derived'`; compose.ts merges these ahead of LLM output.
 *
 * Whether a derived tag *suppresses* LLM tags in the same category depends on
 * whether that category is single-valued — see EXCLUSIVE_DERIVED_CATEGORIES.
 */
import type { Book, GeneratedTag, TagCategory } from './types.js';

/**
 * Categories where a derived tag is the ONLY correct answer, so any LLM tag in
 * the same category is dropped. A book has exactly one length and one era.
 *
 * `structure` is deliberately absent: `full-cast` describes the production,
 * while `single-pov`/`multi-pov`/`epistolary` describe the narrative, and a
 * book has both. Letting a derived `full-cast` claim the category would
 * silently delete the POV tag from every GraphicAudio title.
 */
export const EXCLUSIVE_DERIVED_CATEGORIES = new Set<TagCategory>(['length', 'era']);

const HOUR = 3600;

/**
 * Full-cast dramatizations — GraphicAudio and the "Dramatized Adaptation"
 * imprints — are a genuinely different listening experience from a single
 * narrator: multiple voice actors, score, sound design. The publisher stamps
 * that into the title, so this is a string match rather than a judgement call,
 * and it reaches ~40 books here where the LLM found 3.
 *
 * One term covers both forms because the query it serves ("something
 * performative") does not distinguish them. They are not identical — a
 * dramatized adaptation may also be abridged and restructured, which this
 * does not attempt to capture.
 */
function deriveFullCast(title: string): string | null {
  const markers = [/\bgraphic\s*audio\b/i, /\bfull[-\s]cast\b/i, /\bdramati[sz]ed\b/i];
  return markers.some((re) => re.test(title)) ? 'full-cast' : null;
}

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

  const fullCast = deriveFullCast(book.title);
  if (fullCast !== null) {
    tags.push({ tag: fullCast, category: 'structure', confidence: 1, source: 'derived' });
  }

  return tags;
}
