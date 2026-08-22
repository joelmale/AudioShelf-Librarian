/**
 * Enrichment provider contract (librarian engine plan §2).
 *
 * A provider resolves one book against one external metadata source. Providers
 * are pure fetch+parse — no DB access, no logging side effects — so they are
 * testable with fixture responses via the injected `fetchImpl` (the same
 * pattern as `recommendations.ts#verifyExternal`).
 */
import type { Book } from '../types.js';

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
