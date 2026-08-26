/**
 * The librarian's retrieval tool registry (librarian engine plan §5.1,
 * readiness item I).
 *
 * Plain, LLM-agnostic functions — no MCP SDK import, no Express, no LLM
 * client. This is the module boundary a future tool-loop (`LlmClient.
 * toolLoop()`, per the plan) attaches to; a future MCP registration can wrap
 * the same `LIBRARIAN_TOOLS` entries instead of re-implementing the
 * retrieval logic a second time, the way §5.1 describes the tools being
 * "registered twice: once for the internal loop, once as MCP tools".
 *
 * READINESS ITEM I, THE RULE THIS FILE EXISTS TO ENFORCE: the tool layer
 * must never call `core/collectionEngine.ts`'s whole-library summary builder
 * — the one that serialises the entire library into a single prompt. That
 * helper is the existing in-repo pattern an implementer would reasonably
 * copy; the tool loop exists to retrieve incrementally instead.
 *
 * (Its exact name is deliberately not spelled out in this docblock: the
 * import-guard test's whole-word check would flag its own explanatory prose
 * the moment it names the symbol, which is why the guard test's own comments
 * paraphrase it the same way this one does — see `tools.importGuard.test.ts`.)
 *
 * `tools.importGuard.test.ts` asserts this file (and `mcp/tools/
 * queryLibrary.ts`, the other librarian retrieval entrypoint) has no import
 * path — direct OR transitive — to `core/collectionEngine.ts`, and
 * separately that that helper's identifier does not appear anywhere in that
 * closure. It is an import-graph assertion, not a grep of today's call
 * sites, so it keeps holding after this file grows.
 *
 * NOT INCLUDED HERE: a `search_semantic` tool (plan §5.1). It needs an
 * `EmbeddingCreator` at query time, to embed the user's own words — that is
 * Phase 4 tool-loop design work (deciding when and how the loop reaches for
 * the embedder), not this piece. `find_similar` — embedding neighbours of a
 * book already OWNED and already embedded — needs no query-time embedding
 * call, which is why it is safe to include now.
 */
import { z } from 'zod';

import type { BookQueryFilters, CuratorDb, TagCoverageReport } from '../db.js';
import { NotFoundError } from '../errors.js';
import { findSimilar, type SimilarBook } from '../retrieval/findSimilar.js';
import { tagCategorySchema, type Book, type BookTag } from '../types.js';
import { libraryCoverage } from './coverage.js';

/**
 * Dependencies a librarian tool handler needs. Deliberately narrower than
 * `mcp/services.ts`'s `McpServices` — that shape drags in the MCP SDK type
 * graph (see its own ARCHITECTURAL BOUNDARY comment: "`src/mcp/` imports
 * ONLY from `src/core/`") and carries services (absClient, llmClient,
 * operations, actionLog) no retrieval tool here touches. Importing
 * `McpServices` into `core/` would also invert that boundary — `core/`
 * depending on `mcp/` — which is why this module defines its own.
 */
export interface LibrarianToolDeps {
  db: CuratorDb;
  /** Same value as `Config.embeddingModel`. Powers the coverage disclosure
   *  attached to `search_library`, and picks which model's vectors
   *  `find_similar` reads (an empty string, meaning "unconfigured", is
   *  threaded through as "no model filter" rather than a literal '' match). */
  embeddingModel: string;
}

export interface LibrarianTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  handler: (deps: LibrarianToolDeps, input: Input) => Output | Promise<Output>;
}

// ── search_library ──────────────────────────────────────────────────────────

/**
 * Same structured-filter surface `mcp/tools/queryLibrary.ts`'s `query_library`
 * already exposes (title/author/tag/category/minConfidence, duration range in
 * hours, series membership, published-year range, limit) — kept identical so
 * a librarian client sees one consistent filter vocabulary regardless of
 * which registration (internal loop vs MCP) it is talking to.
 */
const searchLibraryInputSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  tag: z.string().optional(),
  category: tagCategorySchema.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  minDurationHours: z.number().optional(),
  maxDurationHours: z.number().optional(),
  series: z.enum(['any', 'standalone', 'in-series']).optional(),
  publishedFrom: z.number().optional(),
  publishedTo: z.number().optional(),
  limit: z.number().optional(),
});
export type SearchLibraryInput = z.infer<typeof searchLibraryInputSchema>;

export interface SearchLibraryResult {
  total: number;
  books: (Book & { tags: BookTag[] })[];
  libraryCoverage?: unknown;
}

function searchLibrary(deps: LibrarianToolDeps, input: SearchLibraryInput): SearchLibraryResult {
  const filters: BookQueryFilters = { limit: 500 };
  if (input.title) filters.search = input.title;
  if (input.author) filters.author = input.author;
  if (input.tag) filters.tag = input.tag;
  if (input.category) filters.category = input.category;
  if (input.minConfidence !== undefined) filters.minConfidence = input.minConfidence;

  let books = deps.db.queryBooks(filters).books;
  const minSec = input.minDurationHours !== undefined ? input.minDurationHours * 3600 : undefined;
  const maxSec = input.maxDurationHours !== undefined ? input.maxDurationHours * 3600 : undefined;
  books = books.filter((b: Book) => {
    if (minSec !== undefined && (b.durationSeconds === null || b.durationSeconds < minSec)) return false;
    if (maxSec !== undefined && (b.durationSeconds === null || b.durationSeconds > maxSec)) return false;
    if (input.series === 'standalone' && b.series !== null) return false;
    if (input.series === 'in-series' && b.series === null) return false;
    if (input.publishedFrom !== undefined && (b.publishedYear === null || b.publishedYear < input.publishedFrom)) return false;
    if (input.publishedTo !== undefined && (b.publishedYear === null || b.publishedYear > input.publishedTo)) return false;
    return true;
  });
  const limit = input.limit ?? 100;
  return {
    total: books.length,
    books: books.slice(0, limit).map((b) => ({ ...b, tags: deps.db.getTagsForBook(b.id) })),
    ...libraryCoverage({ db: deps.db, embeddingModel: deps.embeddingModel }),
  };
}

// ── get_book ─────────────────────────────────────────────────────────────────

const getBookInputSchema = z.object({ id: z.string() });
export type GetBookInput = z.infer<typeof getBookInputSchema>;

export interface GetBookResult {
  book: Book;
  tags: BookTag[];
}

function getBook(deps: LibrarianToolDeps, input: GetBookInput): GetBookResult {
  const book = deps.db.getBook(input.id);
  if (!book) throw new NotFoundError(`No book with id ${input.id}`);
  return { book, tags: deps.db.getTagsForBook(book.id) };
}

// ── find_similar ─────────────────────────────────────────────────────────────

const findSimilarInputSchema = z.object({
  bookId: z.string(),
  /** How many neighbours to return. Default 10 (see `findSimilar`). */
  k: z.number().optional(),
  /** Exclude every candidate sharing a genre tag with the anchor — the
   *  cross-domain / "if you like X" archetype (plan §5.2 archetype 2). */
  acrossGenre: z.boolean().optional(),
});
export type FindSimilarInput = z.infer<typeof findSimilarInputSchema>;

export interface FindSimilarResult {
  results: SimilarBook[];
}

/**
 * Wraps `findSimilar`. Deliberately does NOT catch its `NotFoundError`
 * (unknown book) or `AppError` (anchor has no embedding) — an empty result
 * would be indistinguishable from "nothing is similar", and the caller's fix
 * for each ("check the id" vs "run the embedding operation first") is
 * entirely different. Let both propagate.
 */
function findSimilarTool(deps: LibrarianToolDeps, input: FindSimilarInput): FindSimilarResult {
  const results = findSimilar(deps.db, input.bookId, {
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.acrossGenre !== undefined ? { acrossGenre: input.acrossGenre } : {}),
    // '' means "unconfigured" (see LibrarianToolDeps) — thread it through as
    // "no model filter", not a literal empty-string model match.
    ...(deps.embeddingModel ? { model: deps.embeddingModel } : {}),
  });
  return { results };
}

// ── tag_coverage ─────────────────────────────────────────────────────────────

const tagCoverageFilterSchema = z.object({
  tag: z.string(),
  category: tagCategorySchema.optional(),
  minConfidence: z.number().optional(),
});
const tagCoverageInputSchema = z.object({
  tags: z.array(tagCoverageFilterSchema).min(1),
  /** Restrict the report to this candidate set (e.g. a prior search's
   *  results). Omitted means "every active book". */
  bookIds: z.array(z.string()).optional(),
});
export type TagCoverageInput = z.infer<typeof tagCoverageInputSchema>;

function tagCoverage(deps: LibrarianToolDeps, input: TagCoverageInput): TagCoverageReport {
  return deps.db.getTagCoverage(input.tags, input.bookIds !== undefined ? { bookIds: input.bookIds } : undefined);
}

// ── registry ─────────────────────────────────────────────────────────────────

/** Union of every concrete tool shape — avoids an `any`/`unknown` erasure at
 *  the registry boundary while still letting heterogeneous tools share one
 *  array. */
type AnyLibrarianTool =
  | LibrarianTool<SearchLibraryInput, SearchLibraryResult>
  | LibrarianTool<GetBookInput, GetBookResult>
  | LibrarianTool<FindSimilarInput, FindSimilarResult>
  | LibrarianTool<TagCoverageInput, TagCoverageReport>;

export const LIBRARIAN_TOOLS: readonly AnyLibrarianTool[] = [
  {
    name: 'search_library',
    description:
      'Search the tagged library by title/author/tag/category/confidence, duration range (hours), series membership, and published-year range. Returns matching books with their tags. If the result carries `libraryCoverage`, this library is materially under-covered: state its `disclosure` sentence before recommending anything. A `pct` of null means Unknown — the check could not run — and must never be reported as 0%.',
    inputSchema: searchLibraryInputSchema,
    handler: searchLibrary,
  },
  {
    name: 'get_book',
    description: 'Return the full card and tags for one book by its ABS id.',
    inputSchema: getBookInputSchema,
    handler: getBook,
  },
  {
    name: 'find_similar',
    description:
      'Embedding-neighbour lookup for a book already in the library ("more like this"). Set acrossGenre to find structurally similar books outside the anchor\'s genre (the "if you like X, but Y" archetype). Throws if the anchor has never been embedded — that means the embedding operation needs to run first, not that nothing is similar.',
    inputSchema: findSimilarInputSchema,
    handler: findSimilarTool,
  },
  {
    name: 'tag_coverage',
    description:
      'For each requested tag, report how many candidate books have it present, are confirmed absent (audited, not present), or were never audited for that category. Use before stating a negative filter as fact — "unaudited" books need a caveat, not a silent inclusion or exclusion.',
    inputSchema: tagCoverageInputSchema,
    handler: tagCoverage,
  },
];
