/**
 * Enrichment provider contract (librarian engine plan §2).
 *
 * A provider resolves one book against one external metadata source. Providers
 * are pure fetch+parse — no DB access, no logging side effects — so they are
 * testable with fixture responses via the injected `fetchImpl` (the same
 * pattern as `recommendations.ts#verifyExternal`).
 */
import type { Book, ExternalMetadataStatus, OperationError } from '../types.js';

export type EntityKind = 'person' | 'place' | 'time';

export interface EnrichedEntity {
  /** Canonical surface form as the provider records it, e.g. "Benjamin Hanscom". */
  entity: string;
  kind: EntityKind;
}

export interface EnrichmentPayload {
  /** Provider response, cached verbatim in external_metadata.payload so entity
   *  extraction can be re-run later without re-fetching. */
  raw: unknown;
  entities: EnrichedEntity[];
  /** Candidate facet terms in the provider's own vocabulary (subjects, genres). */
  subjects: string[];
}

export interface EnrichmentProvider {
  /** Stable identifier, stored as external_metadata.provider (e.g. 'openlibrary'). */
  readonly name: string;
  /**
   * Resolve this book. Return the payload on a confident match; return null
   * when the provider has no record for the book (cached as 'not-found');
   * throw a typed error on transport/parse failures (cached as 'error' and
   * retried sooner than not-found).
   */
  lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrichment runner (core/enrichment/enricher.ts) result types.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-book entry returned by a dry run (no fetches made). */
export interface EnrichmentPlanEntry {
  bookId: string;
  title: string;
  /** Provider names that are due for a lookup on this book. */
  providers: string[];
}

/** Per-provider counters accumulated over one enrichment run. */
export interface ProviderStats {
  /** Lookups actually attempted (fresh-cache books never reach this). */
  fetched: number;
  ok: number;
  notFound: number;
  errors: number;
}

export interface EnrichmentResult {
  processed: number;
  skipped: number;
  failed: number;
  errors: OperationError[];
  dryRun: boolean;
  /** Present on a dry run: the books (and due providers) that would have been fetched. */
  plan?: EnrichmentPlanEntry[];
  /** True when the run was cancelled before completing all candidates. */
  cancelled?: boolean;
  /** Total book_entities rows written across every book whose allowlist was rebuilt. */
  entitiesWritten: number;
  providerStats: Record<string, ProviderStats>;
  /**
   * Ids of the books this run actually enriched (rebuilt book_entities for),
   * empty on a dry run. Lets a caller scope a follow-up operation — the
   * readiness-plan item B re-embed — to exactly the books whose grounded
   * entities changed, instead of the whole candidate pool or the whole
   * library.
   */
  processedBookIds: string[];
  /** True when this run reduced the candidate pool to a representative sample. */
  sample?: boolean;
  /** QC summary of this run against the live providers — produced for every
   *  non-dry run (cheap to compute), sample or full. */
  qualityReport?: EnrichmentQualityReport;
}

/** QC summary of one enrichment run, meant to let a user eyeball provider
 *  quality and entity coverage before committing to (or trusting) a full run. */
export interface EnrichmentQualityReport {
  /** Books actually run (post-sample, or the full candidate pool on a full run). */
  sampled: number;
  /** Full candidate pool size before sampling was applied. */
  candidatesTotal: number;
  providers: Record<string, ProviderStats & { hitRate: number }>;
  entityCoverage: {
    withEntities: number;
    withoutEntities: number;
    avgEntitiesPerBook: number;
    /** Books with at least one entity that survived notability scoring. A book
     *  can have entities but no NOTABLE ones — a 697-entry Open Library
     *  concordance where nothing cleared the threshold. Reporting only
     *  `withEntities` hides exactly that case. */
    withNotableEntities: number;
    avgNotablePerBook: number;
  };
  /** First min(10, sampled) books, for eyeballing. */
  examples: Array<{
    bookId: string;
    title: string;
    /** Status per provider THIS run (only providers that were due). */
    providers: Record<string, ExternalMetadataStatus>;
    /** Up to 8, post-rebuild, NOTABLE FIRST. Ordering matters: `book_entities`
     *  is stored `ORDER BY kind, entity`, so an alphabetical slice of a large
     *  concordance shows only its A-names and reads as pure noise — a real
     *  report rendered Carrie as "Amelia Jenks, Andrea Kolintz, Annie Jenks,
     *  Billy DeLois…" while the actual cast scored fine and was never shown. */
    entities: Array<{ entity: string; kind: string; notable: boolean }>;
    /** Totals behind the truncated `entities` list. */
    entityCounts: { total: number; notable: number };
    /** Up to 8, union across cached 'ok' payloads. */
    subjects: string[];
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Title-parse runner (core/enrichment/titleParser.ts) result types.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-book row in a title-parse dry run's review table — the mechanism by
 * which a user confirms nothing is being lost before any write happens.
 * `wouldFill` names the `books` fields (subset of `['author',
 * 'publishedYear']`) that a real run would fill — never `seriesSequence`,
 * which `parseTitle`'s `ordinal` is deliberately never written to (see
 * titleParse.ts's docblock).
 */
export interface TitleParseReviewEntry {
  bookId: string;
  originalTitle: string;
  normalizedTitle: string;
  /**
   * What the book already carries. Shown so a reviewer can distinguish a parse
   * that found nothing from one whose finding is merely redundant — without
   * it, a column of "would fill: —" reads like the feature is broken.
   */
  existingAuthor: string | null;
  existingYear: number | null;
  parsedAuthor: string | null;
  parsedYear: number | null;
  ordinal: number | null;
  confidence: 'high' | 'low';
  wouldFill: string[];
}

export interface TitleParseResult {
  processed: number;
  skipped: number;
  failed: number;
  errors: OperationError[];
  dryRun: boolean;
  /** True when the run was cancelled before completing all candidates. */
  cancelled?: boolean;
  /** True when this run reduced the candidate pool to a representative sample. */
  sample?: boolean;
  /** Present on a dry run: up to `REVIEW_CAP` rows, for eyeballing. */
  review?: TitleParseReviewEntry[];
  /** Present on a dry run: the true row count behind `review`, independent of its cap. */
  reviewTotal?: number;
  /** Count of books whose parse would fill (or, on a real run, filled) a null author. */
  filledAuthorCount: number;
  /** Count of books whose parse would fill (or, on a real run, filled) a null published year. */
  filledYearCount: number;
  /** Count of books whose parse landed at `confidence: 'low'`. */
  lowConfidenceCount: number;
}
