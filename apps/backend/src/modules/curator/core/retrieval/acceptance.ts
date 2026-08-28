import { z } from 'zod';

import type { CuratorDb } from '../db.js';
import { tagCategorySchema, type Book, type BookEmbedding, type BookTag } from '../types.js';
import { cosineSimilarity, EmbeddingStore } from './embeddings.js';
import { rankBooks, type RankWeights } from './ranker.js';

const nullableStringSchema = z.string().nullable();
const nullableFiniteSchema = z.number().finite().nullable();
const nullableIntegerSchema = z.number().finite().int().nullable();
const titleParseSchema = z.object({
  original: z.string(),
  normalizedTitle: z.string(),
  candidateTitles: z.array(z.string()),
  author: nullableStringSchema,
  year: nullableIntegerSchema,
  ordinal: nullableIntegerSchema,
  series: nullableStringSchema,
  seriesSequence: nullableFiniteSchema,
  confidence: z.enum(['high', 'low']),
}).strict();
const bookSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  author: nullableStringSchema,
  series: nullableStringSchema,
  seriesSequence: nullableFiniteSchema,
  durationSeconds: z.number().finite().int().nonnegative().nullable(),
  publishedYear: nullableIntegerSchema,
  genres: z.array(z.string()),
  description: nullableStringSchema,
  coverPath: nullableStringSchema,
  absAddedAt: z.number().finite().int().nonnegative().nullable(),
  lastSyncedAt: z.number().finite().int().nonnegative(),
  libraryId: nullableStringSchema.optional(),
  itemPath: nullableStringSchema.optional(),
  asin: nullableStringSchema.optional(),
  isbn: nullableStringSchema.optional(),
  absUpdatedAt: z.number().finite().int().nonnegative().nullable().optional(),
  lastSeenSyncId: nullableStringSchema.optional(),
  syncStatus: z.enum(['active', 'deleted']).optional(),
  deletedAt: z.number().finite().int().nonnegative().nullable().optional(),
  normalizedTitle: nullableStringSchema.optional(),
  titleParse: titleParseSchema.nullable().optional(),
  titleMetaSource: z.record(z.string(), z.string()).nullable().optional(),
}).strict();
const tagSourceSchema = z.union([
  z.enum(['vocab', 'derived', 'llm-open', 'abs']),
  z.string().regex(/^external:.+$/),
]);
const snapshotTagSchema = z.object({
  id: z.number().finite().int().positive(),
  bookId: z.string().min(1),
  tag: z.string().min(1),
  category: tagCategorySchema,
  confidence: z.number().finite().min(0).max(1),
  taggedAt: z.number().finite().int().nonnegative(),
  source: tagSourceSchema,
}).strict();
const snapshotEmbeddingSchema = z.object({
  bookId: z.string().min(1),
  model: z.string().min(1),
  cardHash: z.string().min(1),
  vector: z.instanceof(Float32Array),
}).strict();

const acceptanceSnapshotSchema = z.object({
  books: z.array(bookSchema).min(1),
  tags: z.array(snapshotTagSchema),
  embeddings: z.array(snapshotEmbeddingSchema),
}).strict().superRefine((snapshot, ctx) => {
  const bookIds = new Set<string>();
  snapshot.books.forEach((book, index) => {
    if (bookIds.has(book.id)) ctx.addIssue({ code: 'custom', path: ['books', index, 'id'], message: `duplicate book id: ${book.id}` });
    if (book.syncStatus === 'deleted') ctx.addIssue({ code: 'custom', path: ['books', index, 'syncStatus'], message: 'deleted books are not valid acceptance candidates' });
    bookIds.add(book.id);
  });
  const tagKeys = new Set<string>();
  snapshot.tags.forEach((tag, index) => {
    if (!bookIds.has(tag.bookId)) ctx.addIssue({ code: 'custom', path: ['tags', index, 'bookId'], message: `orphan tag for ${tag.bookId}` });
    const key = `${tag.bookId}\0${tag.tag}`;
    if (tagKeys.has(key)) ctx.addIssue({ code: 'custom', path: ['tags', index], message: `duplicate tag ${tag.tag} for ${tag.bookId}` });
    tagKeys.add(key);
  });
  const embeddingIds = new Set<string>();
  let dimension: number | undefined;
  snapshot.embeddings.forEach((embedding, index) => {
    if (!bookIds.has(embedding.bookId)) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'bookId'], message: `orphan embedding for ${embedding.bookId}` });
    if (embeddingIds.has(embedding.bookId)) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'bookId'], message: `duplicate embedding for ${embedding.bookId}` });
    embeddingIds.add(embedding.bookId);
    if (embedding.vector.length === 0) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'vector'], message: 'embedding vector must not be empty' });
    if (dimension === undefined) dimension = embedding.vector.length;
    else if (embedding.vector.length !== dimension) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'vector'], message: `embedding dimension mismatch: expected ${dimension}, got ${embedding.vector.length}` });
    let normSquared = 0;
    for (const value of embedding.vector) {
      if (!Number.isFinite(value)) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'vector'], message: 'embedding vector contains a non-finite value' });
      normSquared += value * value;
    }
    if (!Number.isFinite(normSquared)) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'vector'], message: 'embedding vector norm is not finite' });
    else if (normSquared === 0) ctx.addIssue({ code: 'custom', path: ['embeddings', index, 'vector'], message: 'embedding vector has zero norm' });
  });
});

const tagFilterSchema = z.object({
  tag: z.string().min(1),
  category: tagCategorySchema.optional(),
}).strict();

const preferredTagSchema = tagFilterSchema.extend({
  weight: z.number().finite().positive().optional(),
}).strict();

const weightsSchema = z
  .object({
    semantic: z.number().finite().min(0).max(1),
    tag: z.number().finite().min(0).max(1),
    reception: z.number().finite().min(0).max(1),
  }).strict()
  .refine((weights) => Math.abs(weights.semantic + weights.tag + weights.reception - 1) < 1e-9, {
    message: 'weight components must sum to 1',
  });

const expectationsSchema = z
  .object({
    /** Exact expected prefix, in order. */
    topBookIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    /** Every id must occur somewhere in the reported top-K. */
    includesInTopK: z.array(z.string().min(1)).min(1).max(20).optional(),
    /** No id may occur in the reported top-K. */
    excludesFromTopK: z.array(z.string().min(1)).min(1).max(20).optional(),
  }).strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'expectations must contain at least one assertion' });

const querySchema = z.object({
  id: z.string().min(1).max(80),
  query: z.string().trim().min(1),
  queryVector: z.array(z.number().finite()).min(1),
  hardFilters: z
    .object({
      author: z.string().min(1).optional(),
      allTags: z.array(tagFilterSchema).max(20).optional(),
      anyTags: z.array(tagFilterSchema).max(20).optional(),
      excludeTags: z.array(tagFilterSchema).max(20).optional(),
      trustedOnly: z.boolean().optional(),
      minDurationHours: z.number().finite().min(0).optional(),
      maxDurationHours: z.number().finite().min(0).optional(),
      series: z.enum(['any', 'standalone', 'in-series']).optional(),
      publishedFrom: z.number().int().optional(),
      publishedTo: z.number().int().optional(),
    }).strict()
    .refine(
      (filters) =>
        filters.minDurationHours === undefined ||
        filters.maxDurationHours === undefined ||
        filters.minDurationHours <= filters.maxDurationHours,
      { message: 'minDurationHours must not exceed maxDurationHours' }
    )
    .refine(
      (filters) =>
        filters.publishedFrom === undefined ||
        filters.publishedTo === undefined ||
        filters.publishedFrom <= filters.publishedTo,
      { message: 'publishedFrom must not exceed publishedTo' }
    )
    .optional(),
  softFilters: z
    .object({
      preferredTags: z.array(preferredTagSchema).max(20).optional(),
      softExcludeTags: z.array(preferredTagSchema).max(20).optional(),
    }).strict()
    .optional(),
  expectations: expectationsSchema.optional(),
}).strict();

export const acceptanceQueryFileSchema = z
  .object({
    version: z.literal(1),
    embeddingModel: z.string().trim().min(1),
    topK: z.number().int().min(1).max(50).default(10),
    weightGrid: z.array(weightsSchema).min(1).max(32),
    queries: z.array(querySchema).min(1).max(10),
  }).strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, query] of file.queries.entries()) {
      if (seen.has(query.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate query id: ${query.id}`, path: ['queries', index, 'id'] });
      }
      seen.add(query.id);
    }
  });

export type AcceptanceQueryFile = z.infer<typeof acceptanceQueryFileSchema>;

export interface AcceptanceSnapshot {
  books: Book[];
  tags: BookTag[];
  embeddings: BookEmbedding[];
}

export function validateAcceptanceSnapshot(input: unknown): AcceptanceSnapshot {
  return acceptanceSnapshotSchema.parse(input) as AcceptanceSnapshot;
}

export interface Quantiles {
  min: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
}

export interface ExpectationResult {
  status: 'not-configured' | 'passed' | 'failed';
  failures: string[];
}

export interface AcceptanceReport {
  version: 1;
  summary: {
    model: string;
    dimension: number;
    bookCount: number;
    embeddedCount: number;
    missingVectorCount: number;
  };
  expectations: {
    configuredRuns: number;
    failedRuns: number;
    failures: Array<{ queryId: string; weights: RankWeights; messages: string[] }>;
  };
  queries: Array<{
    id: string;
    query: string;
    candidateCount: number;
    embeddedCandidateCount: number;
    cosineQuantiles: Quantiles;
    runs: Array<{
      weights: RankWeights;
      rankings: Array<{
        rank: number;
        bookId: string;
        title: string;
        author: string | null;
        score: number;
        components: { semantic: number; tag: number; reception: number };
      }>;
      topGaps: number[];
      expectations: ExpectationResult;
    }>;
  }>;
}

export function parseAcceptanceQueryFile(input: unknown): AcceptanceQueryFile {
  return acceptanceQueryFileSchema.parse(input);
}

/** Linear-interpolated percentile (R-7), deterministic for every input size. */
export function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile of an empty set');
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('percentile probability must be between 0 and 1');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function quantiles(values: readonly number[]): Quantiles {
  return {
    min: percentile(values, 0),
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: percentile(values, 1),
  };
}

function tagMatches(tag: BookTag, filter: { tag: string; category?: string }, trustedOnly: boolean): boolean {
  return (
    tag.tag === filter.tag &&
    (filter.category === undefined || tag.category === filter.category) &&
    (!trustedOnly || tag.source !== 'llm-open')
  );
}

function asciiFold(character: string): string {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
}

/** SQLite LIKE without ESCAPE: `%` and `_` are wildcards and NOCASE folds ASCII only. */
export function matchesSqliteLike(value: string, pattern: string): boolean {
  const valueChars = Array.from(value);
  const patternChars = Array.from(pattern);
  const memo = new Map<string, boolean>();
  const match = (valueIndex: number, patternIndex: number): boolean => {
    const key = `${valueIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    const token = patternChars[patternIndex];
    if (token === undefined) result = valueIndex === valueChars.length;
    else if (token === '%') result = match(valueIndex, patternIndex + 1) || (valueIndex < valueChars.length && match(valueIndex + 1, patternIndex));
    else if (valueIndex >= valueChars.length) result = false;
    else if (token === '_') result = match(valueIndex + 1, patternIndex + 1);
    else result = asciiFold(token) === asciiFold(valueChars[valueIndex]!) && match(valueIndex + 1, patternIndex + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function applyHardFilters(
  books: readonly Book[],
  tagsByBook: ReadonlyMap<string, readonly BookTag[]>,
  filters: AcceptanceQueryFile['queries'][number]['hardFilters']
): Book[] {
  if (!filters) return [...books];
  const trustedOnly = filters.trustedOnly ?? false;
  const minSeconds = filters.minDurationHours === undefined ? undefined : filters.minDurationHours * 3600;
  const maxSeconds = filters.maxDurationHours === undefined ? undefined : filters.maxDurationHours * 3600;
  return books.filter((book) => {
    const tags = tagsByBook.get(book.id) ?? [];
    if (filters.author && (book.author === null || !matchesSqliteLike(book.author, `%${filters.author}%`))) return false;
    if (filters.allTags?.some((filter) => !tags.some((tag) => tagMatches(tag, filter, trustedOnly)))) return false;
    if (filters.anyTags?.length && !filters.anyTags.some((filter) => tags.some((tag) => tagMatches(tag, filter, trustedOnly)))) return false;
    // Exclusions deliberately consider every provenance, regardless of trustedOnly.
    if (filters.excludeTags?.some((filter) => tags.some((tag) => tagMatches(tag, filter, false)))) return false;
    if (minSeconds !== undefined && (book.durationSeconds === null || book.durationSeconds < minSeconds)) return false;
    if (maxSeconds !== undefined && (book.durationSeconds === null || book.durationSeconds > maxSeconds)) return false;
    if (filters.series === 'standalone' && book.series !== null) return false;
    if (filters.series === 'in-series' && book.series === null) return false;
    if (filters.publishedFrom !== undefined && (book.publishedYear === null || book.publishedYear < filters.publishedFrom)) return false;
    if (filters.publishedTo !== undefined && (book.publishedYear === null || book.publishedYear > filters.publishedTo)) return false;
    return true;
  });
}

export function evaluateExpectations(
  rankedBookIds: readonly string[],
  expectations: AcceptanceQueryFile['queries'][number]['expectations']
): ExpectationResult {
  if (!expectations) return { status: 'not-configured', failures: [] };
  const failures: string[] = [];
  if (expectations.topBookIds) {
    expectations.topBookIds.forEach((bookId, index) => {
      if (rankedBookIds[index] !== bookId) failures.push(`rank ${index + 1}: expected ${bookId}, got ${rankedBookIds[index] ?? '<none>'}`);
    });
  }
  for (const bookId of expectations.includesInTopK ?? []) {
    if (!rankedBookIds.includes(bookId)) failures.push(`expected ${bookId} in top-K`);
  }
  for (const bookId of expectations.excludesFromTopK ?? []) {
    if (rankedBookIds.includes(bookId)) failures.push(`expected ${bookId} outside top-K`);
  }
  return { status: failures.length === 0 ? 'passed' : 'failed', failures };
}

export function runAcceptanceHarness(unparsedSnapshot: unknown, unparsedFile: unknown): AcceptanceReport {
  const snapshot = validateAcceptanceSnapshot(unparsedSnapshot);
  const file = parseAcceptanceQueryFile(unparsedFile);
  const embeddings = snapshot.embeddings.filter((embedding) => embedding.model === file.embeddingModel);
  if (embeddings.length !== snapshot.embeddings.length) {
    throw new Error(`snapshot contains embeddings outside configured model ${file.embeddingModel}`);
  }
  if (embeddings.length === 0) throw new Error(`snapshot has no embeddings for model ${file.embeddingModel}`);
  const dimension = embeddings[0]!.vector.length;
  if (dimension === 0) throw new Error('stored embedding vectors must not be empty');
  for (const embedding of embeddings) {
    if (embedding.vector.length !== dimension) {
      throw new Error(`wrong vector dimension for ${embedding.bookId}: expected ${dimension}, got ${embedding.vector.length}`);
    }
    let normSquared = 0;
    for (const value of embedding.vector) {
      if (!Number.isFinite(value)) throw new Error(`stored embedding vector for ${embedding.bookId} contains a non-finite value`);
      normSquared += value * value;
    }
    if (normSquared === 0) throw new Error(`stored embedding vector for ${embedding.bookId} has zero norm`);
  }

  const tagsByBook = new Map<string, BookTag[]>();
  for (const tag of snapshot.tags) {
    const tags = tagsByBook.get(tag.bookId) ?? [];
    tags.push(tag);
    tagsByBook.set(tag.bookId, tags);
  }
  const dbAdapter = { getTagsForBook: (bookId: string) => tagsByBook.get(bookId) ?? [] } as unknown as CuratorDb;
  const store = new EmbeddingStore(embeddings);
  const embeddedIds = new Set(embeddings.map((embedding) => embedding.bookId));

  const queries = file.queries.map((query) => {
    if (query.queryVector.length !== dimension) {
      throw new Error(`wrong query vector dimension for ${query.id}: expected ${dimension}, got ${query.queryVector.length}`);
    }
    const queryVector = Float32Array.from(query.queryVector);
    if ([...queryVector].some((value) => !Number.isFinite(value))) {
      throw new Error(`query vector for ${query.id} contains a value outside the Float32 range`);
    }
    let queryNormSquared = 0;
    for (const value of queryVector) queryNormSquared += value * value;
    if (queryNormSquared === 0) throw new Error(`query vector for ${query.id} has zero norm`);
    const candidates = applyHardFilters(snapshot.books, tagsByBook, query.hardFilters);
    const candidateIds = new Set(candidates.map((book) => book.id));
    const candidateEmbeddings = embeddings.filter((embedding) => candidateIds.has(embedding.bookId));
    if (candidateEmbeddings.length === 0) throw new Error(`query ${query.id} has no embedded candidates after hard filters`);
    const cosineValues = candidateEmbeddings.map((embedding) => cosineSimilarity(queryVector, embedding.vector));

    const runs = file.weightGrid.map((weights) => {
      const ranked = rankBooks(
        {
          candidates,
          queryVector,
          store,
          preferredTags: query.softFilters?.preferredTags,
          softExcludeTags: query.softFilters?.softExcludeTags,
          weights,
        },
        dbAdapter
      ).slice(0, file.topK);
      const rankings = ranked.map((result, index) => ({
        rank: index + 1,
        bookId: result.book.id,
        title: result.book.title,
        author: result.book.author,
        score: result.score,
        components: result.components,
      }));
      return {
        weights,
        rankings,
        topGaps: rankings.slice(0, -1).map((result, index) => result.score - rankings[index + 1]!.score),
        expectations: evaluateExpectations(rankings.map((result) => result.bookId), query.expectations),
      };
    });

    return {
      id: query.id,
      query: query.query,
      candidateCount: candidates.length,
      embeddedCandidateCount: candidates.filter((book) => embeddedIds.has(book.id)).length,
      cosineQuantiles: quantiles(cosineValues),
      runs,
    };
  });

  const expectationFailures = queries.flatMap((query) =>
    query.runs
      .filter((run) => run.expectations.status === 'failed')
      .map((run) => ({ queryId: query.id, weights: run.weights, messages: run.expectations.failures }))
  );
  const configuredRuns = queries.reduce(
    (count, query) => count + query.runs.filter((run) => run.expectations.status !== 'not-configured').length,
    0
  );

  return {
    version: 1,
    summary: {
      model: file.embeddingModel,
      dimension,
      bookCount: snapshot.books.length,
      embeddedCount: snapshot.books.filter((book) => embeddedIds.has(book.id)).length,
      missingVectorCount: snapshot.books.filter((book) => !embeddedIds.has(book.id)).length,
    },
    expectations: {
      configuredRuns,
      failedRuns: expectationFailures.length,
      failures: expectationFailures,
    },
    queries,
  };
}
