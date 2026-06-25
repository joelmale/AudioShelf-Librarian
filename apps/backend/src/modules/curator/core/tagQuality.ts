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

/** Curated vocabulary per category (from the plan). OOV tags are warned, not rejected. */
const VOCABULARY: Record<TagCategory, ReadonlySet<string>> = {
  genre: new Set([
    'hard-sci-fi',
    'space-opera',
    'cyberpunk',
    'dystopian',
    'military-sci-fi',
    'fantasy',
    'thriller',
  ]),
  mood: new Set(['dark', 'humorous', 'hopeful', 'tense', 'meditative', 'action-driven']),
  theme: new Set(['first-contact', 'ai', 'time-travel', 'post-apocalyptic', 'political', 'survival', 'dystopian']),
  era: new Set(['golden-age', 'new-wave', 'modern', 'classic']),
  pacing: new Set(['slow-burn', 'fast-paced', 'episodic', 'dense']),
  length: new Set(['short', 'medium', 'long', 'epic']),
  audience: new Set(['adult', 'ya', 'all-ages']),
};

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

  const outOfVocabulary = db
    .getTagVocabulary()
    .filter((entry) => {
      const vocab = VOCABULARY[entry.category];
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
