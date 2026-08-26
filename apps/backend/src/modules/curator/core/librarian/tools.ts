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
 * `search_semantic` embeds the caller's own query text at call time via
 * `LibrarianToolDeps.embeddingCreator` — an injected `EmbeddingCreator` (see
 * `core/retrieval/embeddings.ts`), the same seam the embedding runner itself
 * is built on, so the only place a query-time embedding call can happen is
 * this one explicit injection point, and tests never have to touch a
 * network to exercise it. Hard filters run first: `db.queryBooks`
 * (author/tag/entity/duration/series/year, plus `excludeTags`/`trustedOnly`),
 * paged past its own per-call row cap (`queryAllBooks`, below — a vibe query
 * ranks the WHOLE filtered set, not one capped page of it, unlike
 * `search_library`'s already-paginated view), narrows the candidate set, and
 * only THEN does `rankBooks` (`core/retrieval/ranker.ts`) score what survives
 * against the embedded query. That order is not a style choice: `rankBooks`
 * itself only orders and never filters (see its own module docblock), so
 * hard-filter-then-rank is the only sequence in which a stated constraint
 * stays absolute instead of degrading into a scoring nudge. `find_similar`
 * — embedding neighbours of a book already OWNED and already embedded —
 * needs no query-time embedding call, which is why it needed no such seam.
 */
import { z } from 'zod';

import type { BookQueryFilters, CuratorDb, TagCoverageReport } from '../db.js';
import { AppError, NotFoundError } from '../errors.js';
import type { EmbeddingCreator } from '../retrieval/embeddings.js';
import { EmbeddingStore } from '../retrieval/embeddings.js';
import { findSimilar, type SimilarBook } from '../retrieval/findSimilar.js';
import { rankBooks, type RankScoreComponents } from '../retrieval/ranker.js';
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
  /** Embeds `search_semantic`'s query text at call time. Same seam
   *  `core/retrieval/embedder.ts` uses to embed books — injectable so tests
   *  never touch the network. `search_semantic` skips calling this entirely
   *  when `embeddingModel` is `''` ("unconfigured", see above): there is no
   *  model to embed the query against, so the query vector stays absent
   *  rather than firing an embed call for a model no book was ever indexed
   *  under. */
  embeddingCreator: EmbeddingCreator;
}

export interface LibrarianTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  handler: (deps: LibrarianToolDeps, input: Input) => Output | Promise<Output>;
}

// ── shared post-query filters ───────────────────────────────────────────────

/**
 * The duration/series/published-year predicates `search_library` and
 * `search_semantic` both apply AFTER `db.queryBooks` — not expressible as
 * hard SQL predicates the way `db.ts`'s tag/entity filters are, so both
 * tools filter the returned candidate set in TypeScript instead. Shared here
 * so the two tools' post-query filtering can never drift apart.
 */
interface PostQueryFilterInput {
  minDurationHours?: number;
  maxDurationHours?: number;
  series?: 'any' | 'standalone' | 'in-series';
  publishedFrom?: number;
  publishedTo?: number;
}

function applyPostQueryFilters(books: readonly Book[], input: PostQueryFilterInput): Book[] {
  const minSec = input.minDurationHours !== undefined ? input.minDurationHours * 3600 : undefined;
  const maxSec = input.maxDurationHours !== undefined ? input.maxDurationHours * 3600 : undefined;
  return books.filter((b) => {
    if (minSec !== undefined && (b.durationSeconds === null || b.durationSeconds < minSec)) return false;
    if (maxSec !== undefined && (b.durationSeconds === null || b.durationSeconds > maxSec)) return false;
    if (input.series === 'standalone' && b.series !== null) return false;
    if (input.series === 'in-series' && b.series === null) return false;
    if (input.publishedFrom !== undefined && (b.publishedYear === null || b.publishedYear < input.publishedFrom)) return false;
    if (input.publishedTo !== undefined && (b.publishedYear === null || b.publishedYear > input.publishedTo)) return false;
    return true;
  });
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

  const books = applyPostQueryFilters(deps.db.queryBooks(filters).books, input);
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

// ── search_semantic ──────────────────────────────────────────────────────────

/** Matches `db.ts`'s `TagFilter` shape for the hard tag predicates this tool
 *  passes straight through to `db.queryBooks` (`allTags`/`anyTags`/`excludeTags`). */
const tagFilterSchema = z.object({
  tag: z.string(),
  category: tagCategorySchema.optional(),
});

/** Matches `ranker.ts`'s `PreferredTag` shape for the soft ranker signals
 *  (`preferredTags`/`softExcludeTags`) — these only re-rank, never filter. */
const preferredTagSchema = z.object({
  tag: z.string(),
  category: tagCategorySchema.optional(),
  /** Relative importance within the tag component. Default 1. */
  weight: z.number().optional(),
});

const searchSemanticInputSchema = z.object({
  /** The user's own prose, embedded at call time — "melancholic coastal autumn". */
  query: z.string().min(1),

  // Hard filters — passed straight through to db.queryBooks, applied BEFORE
  // scoring. A book that fails one of these is never returned, no matter how
  // well `query` matches it.
  author: z.string().optional(),
  allTags: z.array(tagFilterSchema).optional(),
  anyTags: z.array(tagFilterSchema).optional(),
  /** Hard ban — considers tags of every provenance regardless of `trustedOnly`. */
  excludeTags: z.array(tagFilterSchema).optional(),
  trustedOnly: z.boolean().optional(),
  minDurationHours: z.number().optional(),
  maxDurationHours: z.number().optional(),
  series: z.enum(['any', 'standalone', 'in-series']).optional(),
  publishedFrom: z.number().optional(),
  publishedTo: z.number().optional(),

  // Soft ranker signals — re-rank the survivors of the hard filters above;
  // never drop a book (see ranker.ts's module docblock).
  preferredTags: z.array(preferredTagSchema).optional(),
  softExcludeTags: z.array(preferredTagSchema).optional(),
  weights: z
    .object({
      semantic: z.number().optional(),
      tag: z.number().optional(),
      reception: z.number().optional(),
    })
    .optional(),

  /** Default 20. */
  limit: z.number().optional(),
});
export type SearchSemanticInput = z.infer<typeof searchSemanticInputSchema>;

const DEFAULT_SEARCH_SEMANTIC_LIMIT = 20;

export interface SearchSemanticResult {
  /** Candidates that survived the hard filters, before the limit slice. */
  total: number;
  /** How many of the RETURNED results actually had a stored embedding — a
   *  measurement, so a caller can tell "ranked semantically" from "ranked on
   *  tags alone because nothing here is embedded". */
  semanticScored: number;
  results: {
    book: Book;
    tags: BookTag[];
    score: number;
    components: RankScoreComponents;
    matchedTags: string[];
  }[];
  libraryCoverage?: unknown;
}

/** `db.queryBooks` hard-caps every call at this many rows (see `db.ts`), so a
 *  single call cannot be trusted to return a whole library the way
 *  `search_semantic` needs — ranking "the entire candidate set" against a
 *  vibe query is the entire point of this tool, not an edge case. Do not
 *  raise the cap in `db.ts`; page past it here instead. */
const QUERY_BOOKS_PAGE_SIZE = 500;

/**
 * Every row matching `filters`, paged past `db.queryBooks`'s per-call cap
 * (`QUERY_BOOKS_PAGE_SIZE`). `search_library` gets away with a single capped
 * call because it presents an already-paginated view to its own caller;
 * `search_semantic` ranks the WHOLE filtered set at once, so silently
 * truncating it to the alphabetically-first page would make every book past
 * that point structurally unreachable by any vibe query, no matter how well
 * it matches — and would make `total` a confident count of the wrong set.
 * `page.total` is the uncapped `COUNT(*)` for the same predicates (see
 * `db.queryBooks`), so it is what tells this loop when to stop.
 */
function queryAllBooks(db: CuratorDb, filters: BookQueryFilters): Book[] {
  const books: Book[] = [];
  let offset = 0;
  for (;;) {
    const page = db.queryBooks({ ...filters, limit: QUERY_BOOKS_PAGE_SIZE, offset });
    books.push(...page.books);
    offset += page.books.length;
    if (page.books.length === 0 || offset >= page.total) break;
  }
  return books;
}

/**
 * Free-form vibe/prose search. Hard filters run first via `queryAllBooks`
 * plus `applyPostQueryFilters` — the same candidate-narrowing
 * `search_library` does, but over the FULL filtered set rather than one
 * page of it (see `queryAllBooks`) — and only then is the query text
 * embedded (skipped entirely when `deps.embeddingModel` is `''`, i.e.
 * unconfigured) and the survivors scored by `rankBooks`. See the module
 * docblock for why that order is load-bearing.
 */
async function searchSemantic(deps: LibrarianToolDeps, input: SearchSemanticInput): Promise<SearchSemanticResult> {
  const filters: BookQueryFilters = {};
  if (input.author) filters.author = input.author;
  if (input.allTags) filters.allTags = input.allTags;
  if (input.anyTags) filters.anyTags = input.anyTags;
  if (input.excludeTags) filters.excludeTags = input.excludeTags;
  if (input.trustedOnly !== undefined) filters.trustedOnly = input.trustedOnly;

  const candidates = applyPostQueryFilters(queryAllBooks(deps.db, filters), input);

  // '' means "unconfigured" (see LibrarianToolDeps) — no model to embed the
  // query against, so the query vector — and the store built for it — stay
  // absent, rather than firing an embed call, or loading every model's
  // vectors into one (dimensionally incompatible) store, for a model no book
  // was ever indexed under.
  let queryVector: Float32Array | undefined;
  let store: EmbeddingStore | undefined;
  if (deps.embeddingModel) {
    const vectors = await deps.embeddingCreator.create({ model: deps.embeddingModel, input: [input.query] });
    const vector = vectors[0];
    // Do NOT let an empty response quietly degrade into "no semantic term" —
    // that would surface as `semanticScored: 0`, whose documented meaning is
    // "these books were never embedded", a confident wrong diagnosis when
    // the embedder itself just misbehaved on a fully-embedded library.
    // `find_similar`'s own wrapper (above) makes this exact argument for not
    // swallowing an embedding-layer failure.
    if (!vector) {
      throw new AppError(
        'LLM_INVALID_RESPONSE',
        `Embedding creator returned no vector for the search_semantic query text`,
        { detail: { received: vectors.length } }
      );
    }
    queryVector = vector;
    store = EmbeddingStore.fromDb(deps.db, deps.embeddingModel);
  }

  const ranked = rankBooks(
    {
      candidates,
      ...(queryVector !== undefined ? { queryVector, store } : {}),
      ...(input.preferredTags !== undefined ? { preferredTags: input.preferredTags } : {}),
      ...(input.softExcludeTags !== undefined ? { softExcludeTags: input.softExcludeTags } : {}),
      ...(input.weights !== undefined ? { weights: input.weights } : {}),
    },
    deps.db
  );

  const limit = input.limit ?? DEFAULT_SEARCH_SEMANTIC_LIMIT;
  const sliced = ranked.slice(0, limit);
  // Alias to a `const` so the closure below narrows cleanly — `store` itself
  // is `let` and TS won't carry the outer narrowing into a nested function.
  const embeddingStore = store;
  const semanticScored = embeddingStore ? sliced.filter((r) => embeddingStore.has(r.book.id)).length : 0;

  return {
    total: candidates.length,
    semanticScored,
    results: sliced.map((r) => ({
      book: r.book,
      tags: deps.db.getTagsForBook(r.book.id),
      score: r.score,
      components: r.components,
      matchedTags: r.matchedTags,
    })),
    ...libraryCoverage({ db: deps.db, embeddingModel: deps.embeddingModel }),
  };
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
  | LibrarianTool<SearchSemanticInput, SearchSemanticResult>
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
    name: 'search_semantic',
    description:
      'Search by free-form vibe or prose — "melancholic coastal autumn", not a tag list. `author`, `allTags`, `anyTags`, `excludeTags`, `trustedOnly`, duration range (hours), series membership, and published-year range are ABSOLUTE hard filters applied before any scoring: a book that fails one is never returned, no matter how well `query` matches its description. `excludeTags` is a hard ban that considers a tag of every provenance, including unverified ones, regardless of `trustedOnly`. `preferredTags` and `softExcludeTags` only re-rank the survivors of the hard filters — they demote or promote, never drop, a book. If `semanticScored` is well below `results.length`, the ranking leaned on tags rather than on `query`\'s meaning — either because most of the returned books have never been embedded, or because no embedding model is configured at all — say so rather than presenting the order as vibe-matched.',
    inputSchema: searchSemanticInputSchema,
    handler: searchSemantic,
  },
  {
    name: 'tag_coverage',
    description:
      'For each requested tag, report how many candidate books have it present, are confirmed absent (audited, not present), or were never audited for that category. Use before stating a negative filter as fact — "unaudited" books need a caveat, not a silent inclusion or exclusion.',
    inputSchema: tagCoverageInputSchema,
    handler: tagCoverage,
  },
];
