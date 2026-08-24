/**
 * Tag-quality validation (Task 2.6).
 *
 * After tagging, verify each tagged book has at least one tag in every required
 * category (genre, mood, pacing, length), all confidences are within [0,1], and
 * warn (do not reject) on out-of-vocabulary tags. Findings are warnings, surfaced
 * to the UI and logged — they never block a run.
 */
import type { CuratorDb } from './db.js';
import { REQUIRED_TAG_CATEGORIES, type TagCategory } from './types.js';

/**
 * Build a per-category membership set from the live `vocab_terms` table
 * (seed + promoted only — proposed/rejected terms are not "in vocabulary").
 * A category with zero seed/promoted rows is omitted from the map entirely,
 * matching the old hardcoded-VOCABULARY behavior where an absent category key
 * meant "don't warn" rather than "everything is OOV".
 */
function buildVocabulary(db: CuratorDb): Map<TagCategory, Set<string>> {
  const vocabulary = new Map<TagCategory, Set<string>>();
  for (const term of db.getVocabTerms(['seed', 'promoted'])) {
    let set = vocabulary.get(term.category);
    if (!set) {
      set = new Set();
      vocabulary.set(term.category, set);
    }
    set.add(term.term);
  }
  return vocabulary;
}

export interface TagQualityReport {
  totalTagged: number;
  booksMissingRequiredCategories: { bookId: string; title: string; missing: TagCategory[] }[];
  invalidConfidence: { bookId: string; tag: string; confidence: number }[];
  outOfVocabulary: { tag: string; category: TagCategory; count: number }[];
  ok: boolean;
}

export function validateTagQuality(db: CuratorDb): TagQualityReport {
  const coverage = db.getBookCategoryCoverage();
  const booksMissingRequiredCategories = coverage
    .map((c) => {
      const present = new Set(c.categories);
      const missing = REQUIRED_TAG_CATEGORIES.filter((cat) => !present.has(cat));
      return { bookId: c.bookId, title: c.title, missing };
    })
    .filter((c) => c.missing.length > 0);

  const invalidConfidence = db.getOutOfRangeConfidences();

  const vocabulary = buildVocabulary(db);
  const outOfVocabulary = db
    .getTagVocabulary()
    .filter((entry) => {
      const vocab = vocabulary.get(entry.category);
      return vocab !== undefined && !vocab.has(entry.tag);
    })
    .map((entry) => ({ tag: entry.tag, category: entry.category, count: entry.count }));

  return {
    totalTagged: coverage.length,
    booksMissingRequiredCategories,
    invalidConfidence,
    outOfVocabulary,
    ok: booksMissingRequiredCategories.length === 0 && invalidConfidence.length === 0,
  };
}
