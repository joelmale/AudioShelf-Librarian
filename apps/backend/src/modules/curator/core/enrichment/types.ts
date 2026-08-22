/**
 * Enrichment provider contract (librarian engine plan §2).
 *
 * A provider resolves one book against one external metadata source. Providers
 * are pure fetch+parse — no DB access, no logging side effects — so they are
 * testable with fixture responses via the injected `fetchImpl` (the same
 * pattern as `recommendations.ts#verifyExternal`).
 */
import type { Book, OperationError } from '../types.js';

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
}
