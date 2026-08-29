/**
 * The hybrid ranker (librarian engine plan, Phase 3 retrieval layer).
 *
 * `score(book) = w_sem · semantic(book) + w_tag · tag(book) + w_rec ·
 * reception(book)`, each component independently clamped to `[0,1]` before
 * weighting.
 *
 * ── This function only orders; it never filters ─────────────────────────────
 * `rankBooks` receives `input.candidates` as a closed set that already
 * survived every hard SQL predicate in `db.queryBooks` — `allTags`,
 * `anyTags`, `excludeTags`, `trustedOnly`, entity filters, duration/series/
 * year bounds. Nothing in this module removes a candidate from the result;
 * it returns exactly `input.candidates.length` entries, reordered. Rejection
 * is the filter layer's job (structured, precise, absolute, happens in SQL
 * before this function is ever called); this module's job is attraction —
 * fuzzy, graded, "how much" rather than "whether".
 *
 * ── Tag overlap: confidence-weighted, normalized, source-discounted ────────
 * For each `preferredTags` entry the ranker looks up the book's own tags
 * (`db.getTagsForBook`) for an exact `(tag, category)` match — `category` is
 * optional on `PreferredTag`, and when omitted any category matches. A hit
 * contributes `weight * confidence * sourceFactor`, where `sourceFactor` is
 * 1 for every trusted provenance (`vocab`, `derived`, `abs`, `external:*`)
 * and **0.5 for `llm-open`**. `llm-open` is raw, ungrounded model output that
 * has not passed vocabulary canonicalization or the promotion queue (see
 * `core/tagging/`) — halving it means an unconfirmed guess can still nudge a
 * ranking but never counts as strongly as a tag the system actually stands
 * behind. This mirrors `BookQueryFilters.trustedOnly`'s treatment of
 * `llm-open` as weak-but-not-worthless evidence *for* a book (db.ts).
 *
 * The raw match sum is divided by the sum of `weight` across **every**
 * supplied `preferredTags` entry (matched or not), not just the ones that
 * hit. That denominator is what keeps the tag component in `[0,1]`
 * regardless of how many preferred tags a query supplies — a query with 8
 * preferred tags and a query with 2 are on the same 0–1 scale, so a caller
 * can't inflate a book's tag score just by listing more facets it doesn't
 * actually need to match.
 *
 * ── `softExcludeTags` demote, they never drop ───────────────────────────────
 * Computed with the exact same confidence-weighted, source-discounted,
 * self-normalized formula as `preferredTags`, over its own set — a book that
 * fully matches every soft-excluded tag scores an exclusion term of 1.0,
 * regardless of how many preferred tags were also supplied. The final tag
 * component is `clamp(preferredScore - excludeScore, 0, 1)`: the floor is 0,
 * not negative — a book can lose its *entire* tag contribution to soft
 * exclusion (e.g. "not a full-on thriller" zeroes out an unambiguous
 * thriller's tag term) but never turns a soft exclusion into a bonus for
 * other candidates, and never influences the semantic or reception
 * components. This is how "not a full-on thriller" demotes a book without
 * banning it outright the way `BookQueryFilters.excludeTags` does.
 *
 * ── Unknown reception is neutral, not zero ──────────────────────────────────
 * `receptionPrior` returns `number | null`; `null` means "no signal", not
 * "bad". Scoring it as 0 would systematically sink every book without rating
 * data below a merely mediocre one, which actively fights the point of a
 * *personal-library* recommender (most of a real library will lack Hardcover
 * ratings until Phase 5 lands them). Unknown is instead scored at the
 * midpoint, **0.5** — exactly as informative as a so-so rating, and neither
 * a thumb on the scale nor a penalty. The same 0.5 applies when
 * `receptionPrior` is omitted entirely: every candidate gets the same
 * constant, so it cannot change relative order, only the absolute score
 * value.
 *
 * ── Every component clamped, deterministic tiebreak ─────────────────────────
 * `semantic`, `tag`, and `reception` are each clamped to `[0,1]` before the
 * weighted sum. Ties in the final score are broken by `book.id` compared as
 * plain codepoints (`a < b`), never `localeCompare` — ICU collation is not
 * guaranteed to agree across Node builds/environments (see `bookCard.ts`),
 * and this ranker's ordering must be exactly reproducible.
 *
 * ── Why these default weights (`DEFAULT_WEIGHTS`) ───────────────────────────
 * The plan's four query archetypes (§5.2) do not all want the same blend —
 * `DEFAULT_WEIGHTS` is the compromise a caller uses when it has no
 * archetype-specific reason to override `weights`, not a claim that one
 * blend is universally correct. Every field here is overridable per call.
 *
 * `semantic: 0.55` — slightly the largest term. Archetype 1 (vibe &
 * atmosphere — "melancholic coastal autumn") is the query shape a controlled
 * tag vocabulary structurally cannot resolve on its own: no amount of tag
 * matching finds a book whose prose *reads* melancholic if it was never
 * tagged that way, but the card embedding reads the actual description and
 * generalizes to phrasings the vocabulary never anticipated. Archetype 2
 * (cross-domain / "if you like X") is also embedding-led — the transferable
 * qualities of an anchor book are found in vector space, with tags only
 * narrowing the genre. Since two of the four archetypes lean on semantic
 * search as the primary signal, it gets the largest default share.
 *
 * `tag: 0.35` — close behind, not far below. Archetype 3 (context &
 * cognitive load — "fast-paced, 45-min commute") and archetype 4 (negative
 * filtering & guardrails) are both structured-first: their *exclusions* are
 * hard SQL predicates already applied before `rankBooks` ever runs, but
 * their *positive* preferences (`pacing:fast-paced`, `length:short`,
 * `genre:space-opera`) are exactly what the tag component is built to score
 * precisely. A caller resolving one of those two archetypes is expected to
 * raise `tag` and lower `semantic` via `weights`; the default keeps tag
 * close enough to semantic that it still meaningfully breaks ties even when
 * a caller doesn't override anything.
 *
 * `reception: 0.10` — deliberately the smallest term, for two reasons.
 * First, it is a tiebreaker by design: this is a *personal-library*
 * recommender, and the value proposition is surfacing what the reader
 * already owns and would enjoy, not re-deriving a bestseller list — a larger
 * weight would let broad popularity drown out both semantic fit and tag
 * match. Second, there is no ratings source anywhere in today's schema
 * (Hardcover ratings arrive in Phase 5, plan §6) so `receptionPrior` will be
 * absent or return `null` for most calls today, and the neutral-0.5 handling
 * above means it usually contributes a small constant rather than real
 * signal. `reception` is kept non-zero rather than 0 so the seam is already
 * wired for Phase 5 instead of requiring a second migration of every caller.
 *
 * **These three numbers are provisional pending real-library tuning** (plan
 * §10.C item 6) — they are tuned against a 30-book synthetic fixture with a
 * deterministic stub embedder, not against `nomic-embed-text`'s actual
 * cosine distribution over a real library. Re-tune once Phase 3.5 embeds the
 * real library and records real vibe queries as the regression suite.
 */
import type { CuratorDb } from '../db.js';
import type { EmbeddingStore } from './embeddings.js';
import type { Book, BookTag, TagCategory, TagSource } from '../types.js';

export interface RankWeights {
  semantic: number;
  tag: number;
  reception: number;
  /** Personalization (Phase 5). Zero by default — see below. */
  taste: number;
}

/**
 * Default weights. See the module docblock for the justification.
 *
 * `taste` defaults to **0**, so personalization is opt-in per call and an
 * install with no feedback ranks bit-identically to how it did before Phase 5
 * existed. Two reasons this is not merely cautious: plan §6 requires that
 * personalization never override an explicit query constraint, and §10.C's
 * acceptance harness must be able to measure retrieval quality without a
 * taste profile silently perturbing the ordering under test.
 */
export const DEFAULT_WEIGHTS: RankWeights = {
  semantic: 0.55,
  tag: 0.35,
  reception: 0.1,
  taste: 0,
};

export interface PreferredTag {
  tag: string;
  category?: TagCategory;
  /** Relative importance within the tag component. Default 1. */
  weight?: number;
}

export interface RankInput {
  /** Already hard-filtered by `db.queryBooks` — see the module docblock. */
  candidates: Book[];
  /** Embedding of the query text. Absent (or no `store`) → semantic term contributes 0. */
  queryVector?: Float32Array;
  store?: EmbeddingStore;
  preferredTags?: PreferredTag[];
  /** Demote, never drop — see the module docblock. */
  softExcludeTags?: PreferredTag[];
  weights?: Partial<RankWeights>;
  /** Reception prior in [0,1] for a book, or null when unknown. `null` and
   *  "omitted entirely" both score the neutral midpoint — see the module docblock. */
  receptionPrior?: (book: Book) => number | null;
  /**
   * Affinity to the user's taste profile in [0,1], or null when unknown
   * (no embedding for this book, or no profile at all). Like `receptionPrior`,
   * `null` means "no signal" and scores the neutral midpoint rather than 0 —
   * scoring an unembedded book as 0 taste would push it below a genuinely
   * disliked one. See `core/feedback/tasteProfile.ts`.
   */
  tastePrior?: (book: Book) => number | null;
}

export interface RankScoreComponents {
  semantic: number; // [0,1]
  tag: number; // [0,1]
  reception: number; // [0,1]
  taste: number; // [0,1]
}

export interface RankedBook {
  book: Book;
  /** Final blended score. In [0,1] whenever `weights` sum to <= 1 (true of `DEFAULT_WEIGHTS`). */
  score: number;
  components: RankScoreComponents;
  /** Which `preferredTags` this book actually carries — drives "Why this?" in the UI. */
  matchedTags: string[];
}

/** An unconfirmed, ungrounded LLM tag counts for half a trusted one. See the
 *  module docblock for the reasoning. */
const LLM_OPEN_CONFIDENCE_FACTOR = 0.5;

/** Neutral score for an unknown reception prior. See the module docblock. */
const NEUTRAL_RECEPTION = 0.5;

/** Neutral score for an unknown taste prior — same argument as reception:
 *  "we have not learned this yet" must not read as "disliked". */
const NEUTRAL_TASTE = 0.5;

/** Plain codepoint comparator — never `localeCompare` (ICU collation is not
 *  guaranteed to match across Node builds/environments; see bookCard.ts). */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sourceFactor(source: TagSource): number {
  return source === 'llm-open' ? LLM_OPEN_CONFIDENCE_FACTOR : 1;
}

/**
 * Confidence-weighted, source-discounted overlap of `wanted` against a
 * book's tags, self-normalized to `[0,1]` by dividing by the total `weight`
 * of every entry in `wanted` (matched or not) — see the module docblock.
 */
function scoreTagList(
  bookTags: readonly BookTag[],
  wanted: readonly PreferredTag[]
): { score: number; matched: string[] } {
  if (wanted.length === 0) return { score: 0, matched: [] };

  let numerator = 0;
  let denominator = 0;
  const matched: string[] = [];
  for (const want of wanted) {
    const weight = want.weight ?? 1;
    denominator += weight;
    const hit = bookTags.find(
      (t) => t.tag === want.tag && (want.category === undefined || t.category === want.category)
    );
    if (hit) {
      numerator += weight * hit.confidence * sourceFactor(hit.source);
      matched.push(want.tag);
    }
  }

  return { score: denominator > 0 ? numerator / denominator : 0, matched };
}

/**
 * Rank `input.candidates` by the hybrid semantic + tag + reception score
 * described in the module docblock. Never drops a candidate — hard filters
 * and exclusions must already have run (via `db.queryBooks`) before this is
 * called. `db` is used only to look up each candidate's tags
 * (`db.getTagsForBook`), and only when `preferredTags`/`softExcludeTags` are
 * non-empty.
 */
export function rankBooks(input: RankInput, db: CuratorDb): RankedBook[] {
  if (input.candidates.length === 0) return [];

  const weights: RankWeights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const preferredTags = input.preferredTags ?? [];
  const softExcludeTags = input.softExcludeTags ?? [];
  const needsTags = preferredTags.length > 0 || softExcludeTags.length > 0;

  // Semantic: score every candidate's stored embedding against the query
  // vector in one pass via the store's own scan. A candidate absent from the
  // store (never embedded) simply has no entry in the returned map and
  // scores 0 below — it is never dropped from the candidate set.
  const semanticActive = input.queryVector !== undefined && input.store !== undefined;
  const semanticScores = new Map<string, number>();
  if (semanticActive) {
    const candidateIds = new Set(input.candidates.map((b) => b.id));
    const raw = input.store!.scoreAll(input.queryVector as Float32Array, { include: candidateIds });
    for (const [bookId, cosine] of raw) semanticScores.set(bookId, clamp01(cosine));
  }

  const ranked: RankedBook[] = input.candidates.map((book) => {
    const semantic = semanticActive ? (semanticScores.get(book.id) ?? 0) : 0;

    let tag = 0;
    let matchedTags: string[] = [];
    if (needsTags) {
      const bookTags = db.getTagsForBook(book.id);
      const preferred = scoreTagList(bookTags, preferredTags);
      const excluded = scoreTagList(bookTags, softExcludeTags);
      tag = clamp01(preferred.score - excluded.score);
      matchedTags = preferred.matched;
    }

    const rawReception = input.receptionPrior ? input.receptionPrior(book) : null;
    const reception = rawReception === null ? NEUTRAL_RECEPTION : clamp01(rawReception);

    const rawTaste = input.tastePrior ? input.tastePrior(book) : null;
    const taste = rawTaste === null ? NEUTRAL_TASTE : clamp01(rawTaste);

    const score = weights.semantic * semantic
      + weights.tag * tag
      + weights.reception * reception
      + weights.taste * taste;

    return {
      book,
      score,
      components: { semantic, tag, reception, taste },
      matchedTags: [...new Set(matchedTags)].sort(compareCodepoint),
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return compareCodepoint(a.book.id, b.book.id);
  });

  return ranked;
}
