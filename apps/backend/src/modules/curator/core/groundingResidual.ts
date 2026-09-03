/**
 * Read-only diagnosis for books that enrichment checked but could not ground.
 *
 * This report sizes the next enrichment-source pilots. It does not infer
 * entities, mutate metadata, or turn a missing entity into a negative claim.
 */
import type { GroundingMetadataOutcome } from './db.js';
import type { Book } from './types.js';
import { resolveDescription } from './enrichment/descriptionText.js';

export interface GroundingResidualDb {
  countActiveBooks(): number;
  getUngroundedBooks(): Book[];
  getExternalMetadataOutcomesForUngroundedBooks(): GroundingMetadataOutcome[];
}

export interface GroundingProviderCoverage {
  provider: string;
  attempted: number;
  resolved: number;
  notFound: number;
  errors: number;
}

export interface GroundingResidualSeries {
  series: string;
  books: number;
  withAsin: number;
  withDescription: number;
  /** Provider -> books with a cached successful metadata result. */
  resolvedByProvider: Record<string, number>;
}

export interface GroundingResidualReport {
  generatedAt: number;
  totalBooks: number;
  groundedBooks: number;
  ungroundedBooks: number;
  withSeries: number;
  withoutSeries: number;
  withAsin: number;
  withDescription: number;
  withResolvedMetadata: number;
  providers: GroundingProviderCoverage[];
  series: GroundingResidualSeries[];
}

interface MutableSeries {
  series: string;
  books: number;
  withAsin: number;
  withDescription: number;
  resolvedByProvider: Map<string, number>;
}

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** Build a stable, complete census over the current active-library snapshot. */
export function computeGroundingResidual(
  db: GroundingResidualDb,
  now: () => number = Date.now
): GroundingResidualReport {
  const totalBooks = db.countActiveBooks();
  const books = db.getUngroundedBooks();
  const metadata = db.getExternalMetadataOutcomesForUngroundedBooks();
  const bookById = new Map(books.map((book) => [book.id, book]));
  const resolvedBooks = new Set<string>();
  const providers = new Map<string, GroundingProviderCoverage>();
  const resolvedProvidersByBook = new Map<string, Set<string>>();

  for (const row of metadata) {
    if (!bookById.has(row.bookId)) continue;
    const coverage = providers.get(row.provider) ?? {
      provider: row.provider,
      attempted: 0,
      resolved: 0,
      notFound: 0,
      errors: 0,
    };
    coverage.attempted += 1;
    if (row.status === 'ok') {
      coverage.resolved += 1;
      resolvedBooks.add(row.bookId);
      const names = resolvedProvidersByBook.get(row.bookId) ?? new Set<string>();
      names.add(row.provider);
      resolvedProvidersByBook.set(row.bookId, names);
    } else if (row.status === 'not-found') {
      coverage.notFound += 1;
    } else {
      coverage.errors += 1;
    }
    providers.set(row.provider, coverage);
  }

  let withSeries = 0;
  let withAsin = 0;
  let withDescription = 0;
  const series = new Map<string, MutableSeries>();

  for (const book of books) {
    const hasAsin = present(book.asin);
    const hasDescription = resolveDescription(book).text !== null;
    if (hasAsin) withAsin += 1;
    if (hasDescription) withDescription += 1;

    const seriesName = book.series?.trim();
    if (!seriesName) continue;
    withSeries += 1;
    const group = series.get(seriesName) ?? {
      series: seriesName,
      books: 0,
      withAsin: 0,
      withDescription: 0,
      resolvedByProvider: new Map<string, number>(),
    };
    group.books += 1;
    if (hasAsin) group.withAsin += 1;
    if (hasDescription) group.withDescription += 1;
    for (const provider of resolvedProvidersByBook.get(book.id) ?? []) {
      group.resolvedByProvider.set(provider, (group.resolvedByProvider.get(provider) ?? 0) + 1);
    }
    series.set(seriesName, group);
  }

  return {
    generatedAt: now(),
    totalBooks,
    groundedBooks: Math.max(0, totalBooks - books.length),
    ungroundedBooks: books.length,
    withSeries,
    withoutSeries: books.length - withSeries,
    withAsin,
    withDescription,
    withResolvedMetadata: resolvedBooks.size,
    providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    series: [...series.values()]
      .map((group) => ({
        series: group.series,
        books: group.books,
        withAsin: group.withAsin,
        withDescription: group.withDescription,
        resolvedByProvider: Object.fromEntries([...group.resolvedByProvider].sort(([a], [b]) => a.localeCompare(b))),
      }))
      .sort((a, b) => b.books - a.books || a.series.localeCompare(b.series)),
  };
}
