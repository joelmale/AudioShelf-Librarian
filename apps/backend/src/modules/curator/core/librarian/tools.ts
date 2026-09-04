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
import { DEFAULT_WEIGHTS, rankBooks, type RankScoreComponents, type RankWeights } from '../retrieval/ranker.js';
import { buildTasteProfile, tasteScoreFor } from '../feedback/tasteProfile.js';
import { hardcoverReceptionPrior } from '../enrichment/providers/hardcover.js';
import {
  resolveSingleTag,
  resolveTagFilters,
  type TagResolutionNote,
} from '../retrieval/tagResolution.js';
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

// Public tool-boundary limits. These are deliberately defined beside the
// registry schemas so the internal loop and every adapter inherit one policy.
const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 300;
const MAX_TAG_LENGTH = 128;
const MAX_QUERY_LENGTH = 4_000;
const MAX_FILTER_ITEMS = 50;
const MAX_CANDIDATE_BOOK_IDS = 500;
const MAX_RESULT_LIMIT = 100;
const MAX_DURATION_HOURS = 10_000;
const MIN_PUBLICATION_YEAR = 1_000;
const MAX_PUBLICATION_YEAR = 3_000;
const MAX_TAG_WEIGHT = 100;

/** Share of the blend personalization takes when a taste profile exists.
 *  Small on purpose — plan §6 calls it "a small prior term in the ranker",
 *  and an explicit query constraint must always outrank taste. */
const TASTE_WEIGHT = 0.15;
/** How many feedback rows feed a profile build. */
const TASTE_FEEDBACK_LIMIT = 1_000;

/** Scale the impersonal components down by `taste` so the blend still sums to
 *  1 and their ratios to each other are unchanged. */
function scaleForTaste(base: RankWeights, taste: number): RankWeights {
  const scale = 1 - taste;
  return {
    semantic: base.semantic * scale,
    tag: base.tag * scale,
    reception: base.reception * scale,
    taste,
  };
}

const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
const titleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
const authorSchema = z.string().trim().min(1).max(MAX_AUTHOR_LENGTH);
const tagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);
const resultLimitSchema = z.number().int().positive().max(MAX_RESULT_LIMIT);
const durationHoursSchema = z.number().min(0).max(MAX_DURATION_HOURS);
const publicationYearSchema = z.number().int().min(MIN_PUBLICATION_YEAR).max(MAX_PUBLICATION_YEAR);

function validDurationRange(input: { minDurationHours?: number; maxDurationHours?: number }): boolean {
  return input.minDurationHours === undefined ||
    input.maxDurationHours === undefined ||
    input.minDurationHours <= input.maxDurationHours;
}

function validPublicationRange(input: { publishedFrom?: number; publishedTo?: number }): boolean {
  return input.publishedFrom === undefined ||
    input.publishedTo === undefined ||
    input.publishedFrom <= input.publishedTo;
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
  title: titleSchema.optional(),
  author: authorSchema.optional(),
  tag: tagSchema.optional(),
  category: tagCategorySchema.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  minDurationHours: durationHoursSchema.optional(),
  maxDurationHours: durationHoursSchema.optional(),
  series: z.enum(['any', 'standalone', 'in-series']).optional(),
  publishedFrom: publicationYearSchema.optional(),
  publishedTo: publicationYearSchema.optional(),
  limit: resultLimitSchema.optional(),
})
  .refine(validDurationRange, { message: 'minDurationHours must be less than or equal to maxDurationHours' })
  .refine(validPublicationRange, { message: 'publishedFrom must be less than or equal to publishedTo' });
export type SearchLibraryInput = z.infer<typeof searchLibraryInputSchema>;

export interface SearchLibraryResult {
  total: number;
  books: (Book & { tags: BookTag[] })[];
  /** Present only when `tag` was canonicalized before it ran. */
  tagResolution?: TagResolutionNote[];
  libraryCoverage?: unknown;
}

function searchLibrary(deps: LibrarianToolDeps, input: SearchLibraryInput): SearchLibraryResult {
  // Exact-lookup surface: the term is resolved to the library's stored form
  // so a spaced or PascalCase spelling still matches, but it is never widened
  // to sibling terms the way `search_semantic`'s OR-shaped fields are.
  const resolvedTag = input.tag
    ? resolveSingleTag(deps.db, input.tag, input.category)
    : null;

  const filters: BookQueryFilters = { limit: 500 };
  if (input.title) filters.search = input.title;
  if (input.author) filters.author = input.author;
  if (resolvedTag) filters.tag = resolvedTag.tag;
  if (input.category) filters.category = input.category;
  if (input.minConfidence !== undefined) filters.minConfidence = input.minConfidence;

  const books = applyPostQueryFilters(deps.db.queryBooks(filters).books, input);
  const limit = input.limit ?? 100;
  return {
    total: books.length,
    books: books.slice(0, limit).map((b) => ({ ...b, tags: deps.db.getTagsForBook(b.id) })),
    ...(resolvedTag?.note ? { tagResolution: [resolvedTag.note] } : {}),
    ...libraryCoverage({ db: deps.db, embeddingModel: deps.embeddingModel }),
  };
}

// ── get_book ─────────────────────────────────────────────────────────────────

const getBookInputSchema = z.object({ id: idSchema });
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
  bookId: idSchema,
  /** How many neighbours to return. Default 10 (see `findSimilar`). */
  k: resultLimitSchema.optional(),
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
  tag: tagSchema,
  category: tagCategorySchema.optional(),
});

/** Matches `ranker.ts`'s `PreferredTag` shape for the soft ranker signals
 *  (`preferredTags`/`softExcludeTags`) — these only re-rank, never filter. */
const preferredTagSchema = z.object({
  tag: tagSchema,
  category: tagCategorySchema.optional(),
  /** Relative importance within the tag component. Default 1. */
  weight: z.number().positive().max(MAX_TAG_WEIGHT).optional(),
});

const rankWeightsSchema = z
  .object({
    semantic: z.number().min(0).max(1).optional(),
    tag: z.number().min(0).max(1).optional(),
    reception: z.number().min(0).max(1).optional(),
    taste: z.number().min(0).max(1).optional(),
  })
  .refine((input) => {
    const weights = { ...DEFAULT_WEIGHTS, ...input };
    const sum = weights.semantic + weights.tag + weights.reception + weights.taste;
    return sum > 0 && sum <= 1;
  }, { message: 'effective semantic, tag, reception, and taste weights must sum to more than 0 and at most 1' });

const searchSemanticInputSchema = z.object({
  /** The user's own prose, embedded at call time — "melancholic coastal autumn". */
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),

  // Hard filters — passed straight through to db.queryBooks, applied BEFORE
  // scoring. A book that fails one of these is never returned, no matter how
  // well `query` matches it.
  author: authorSchema.optional(),
  allTags: z.array(tagFilterSchema).max(MAX_FILTER_ITEMS).optional(),
  anyTags: z.array(tagFilterSchema).max(MAX_FILTER_ITEMS).optional(),
  /** Hard ban — considers tags of every provenance regardless of `trustedOnly`. */
  excludeTags: z.array(tagFilterSchema).max(MAX_FILTER_ITEMS).optional(),
  trustedOnly: z.boolean().optional(),
  minDurationHours: durationHoursSchema.optional(),
  maxDurationHours: durationHoursSchema.optional(),
  series: z.enum(['any', 'standalone', 'in-series']).optional(),
  publishedFrom: publicationYearSchema.optional(),
  publishedTo: publicationYearSchema.optional(),

  // Soft ranker signals — re-rank the survivors of the hard filters above;
  // never drop a book (see ranker.ts's module docblock).
  preferredTags: z.array(preferredTagSchema).max(MAX_FILTER_ITEMS).optional(),
  softExcludeTags: z.array(preferredTagSchema).max(MAX_FILTER_ITEMS).optional(),
  weights: rankWeightsSchema.optional(),
  /** Blend in the user's taste profile as a ranker prior (Phase 5). Default
   *  false: personalization is opt-in, and it can only reorder books that
   *  already passed every hard filter. */
  personalize: z.boolean().optional(),

  /** Default 20. */
  limit: resultLimitSchema.optional(),
})
  .refine(validDurationRange, { message: 'minDurationHours must be less than or equal to maxDurationHours' })
  .refine(validPublicationRange, { message: 'publishedFrom must be less than or equal to publishedTo' });
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
  /** Present only when a supplied tag filter was canonicalized or widened
   *  before it ran. A disclosure surface, not a result — see
   *  `retrieval/tagResolution.ts`. */
  tagResolution?: TagResolutionNote[];
  /** True when a taste profile actually blended into this ranking. False
   *  under `personalize: true` means the cold-start gate held (§10.J) — the
   *  order is impersonal and should not be described as tailored. */
  personalized: boolean;
  libraryCoverage?: unknown;
}

/** `db.queryBooks` hard-caps every call at this many rows (see `db.ts`), so a
 *  single call cannot be trusted to return a whole library the way
 *  `search_semantic` needs — ranking "the entire candidate set" against a
 *  vibe query is the entire point of this tool, not an edge case. Do not
 *  raise the cap in `db.ts`; page past it here instead. */
const QUERY_BOOKS_PAGE_SIZE = 500;

/**
 * Hard bound on {@link queryAllBooks}'s page loop. At the 500-row page size
 * this allows 50,000 books — two orders of magnitude past the "hundreds to a
 * few thousand" a personal library holds (plan §0). It exists so a
 * `queryBooks` that ever stopped honouring `offset` would return a truncated
 * result instead of spinning forever; it can never fire on a real library.
 */
const MAX_CANDIDATE_PAGES = 100;

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
 *
 * DEDUPLICATION IS NOT OPTIONAL — DO NOT "SIMPLIFY" IT BACK OUT. `queryBooks`
 * sorts by `ORDER BY b.title` with no tiebreaker, and SQLite guarantees no
 * stable order among equal titles *across separate queries*. Two books
 * sharing a title either side of a page boundary can therefore be returned
 * twice by consecutive offset pages, or skipped entirely. A duplicate
 * inflates `total` and seats one book twice in the ranking; a skip makes a
 * book unreachable — which is the exact failure this paging exists to kill,
 * reintroduced by a subtler route. Keying by id collapses the duplicate case
 * outright. (The skip case is not fully fixable from here without an ordering
 * change in `db.ts`; it is strictly rarer, and it is why this loop stops on
 * `total` rather than trusting a page count.)
 */
function queryAllBooks(db: CuratorDb, filters: BookQueryFilters): Book[] {
  const byId = new Map<string, Book>();
  let offset = 0;
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page += 1) {
    const result = db.queryBooks({ ...filters, limit: QUERY_BOOKS_PAGE_SIZE, offset });
    for (const book of result.books) byId.set(book.id, book);
    offset += result.books.length;
    if (result.books.length === 0 || offset >= result.total) break;
  }
  return [...byId.values()];
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
  // Callers hand us free text — a planner LLM's plan, or tool arguments the
  // answering model wrote itself — while tags are stored canonicalized and
  // kebab-cased. Resolve before these become SQL predicates, or a filter like
  // `murder mystery` is not strict, it is unsatisfiable (see tagResolution.ts).
  const resolved = resolveTagFilters(deps.db, input);
  const resolutionNotes = [...resolved.notes];

  if (resolved.invalidHardFields.length > 0) {
    return {
      total: 0,
      semanticScored: 0,
      results: [],
      personalized: false,
      ...(resolutionNotes.length > 0 ? { tagResolution: resolutionNotes } : {}),
      ...libraryCoverage({ db: deps.db, embeddingModel: deps.embeddingModel }),
    };
  }

  const filters: BookQueryFilters = {};
  if (input.author) filters.author = input.author;
  if (resolved.allTags) filters.allTags = resolved.allTags;
  if (resolved.anyTags) filters.anyTags = resolved.anyTags;
  if (resolved.excludeTags) filters.excludeTags = resolved.excludeTags;
  if (input.trustedOnly !== undefined) filters.trustedOnly = input.trustedOnly;

  const candidates = applyPostQueryFilters(queryAllBooks(deps.db, filters), input);
  const preferredTags = resolved.preferredTags;

  // '' means "unconfigured" (see LibrarianToolDeps) — no model to embed the
  // query against, so the query vector — and the store built for it — stay
  // absent, rather than firing an embed call, or loading every model's
  // vectors into one (dimensionally incompatible) store, for a model no book
  // was ever indexed under.
  let queryVector: Float32Array | undefined;
  let store: EmbeddingStore | undefined;
  if (deps.embeddingModel && candidates.length > 0) {
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

  // Personalization is a ranker PRIOR, exactly as plan §6 specifies — it
  // reorders books that already survived every hard filter, so an explicit
  // query constraint can never be overridden by taste. When no profile exists
  // yet (§10.J cold start) the weights fall back to the impersonal defaults
  // rather than scoring every book at a neutral constant, so a new user's
  // ranking is identical to what it was before Phase 5.
  const tasteProfile = input.personalize
    ? buildTasteProfile({
      feedback: deps.db.getRecFeedback({ limit: TASTE_FEEDBACK_LIMIT }),
      progress: deps.db.getAllListeningProgress(),
      store: store ?? EmbeddingStore.fromDb(deps.db, deps.embeddingModel || undefined),
      now: Date.now(),
    })
    : null;
  const tasteStore = tasteProfile ? (store ?? EmbeddingStore.fromDb(deps.db, deps.embeddingModel || undefined)) : null;

  // With a profile, scale the impersonal weights down by TASTE_WEIGHT and give
  // that share to taste, so the blend still sums to 1 and the semantic:tag
  // ratio §10.C tuned stays intact. An explicit `weights` argument always
  // wins — a caller that pinned its own blend gets exactly what it asked for.
  // Reception prior (§4.3's `w_rec`). It has been scoring the neutral 0.5 for
  // every book since Phase 3 because nothing populated it; Hardcover ratings
  // do now, where they are cached. A book with no cached row, or too few
  // ratings to mean anything, still reports null and stays neutral — never 0,
  // which would sink every unrated book below a merely mediocre one.
  const receptionPrior = (book: Book): number | null => {
    const cached = deps.db.getExternalMetadataForProvider(book.id, 'hardcover');
    // `payload` arrives already parsed from the JSON column (see
    // ExternalMetadataRecord); it is null for a not-found or error row.
    if (!cached || cached.status !== 'ok' || cached.payload === null) return null;
    return hardcoverReceptionPrior(cached.payload);
  };

  const rankWeights: Partial<RankWeights> | undefined = input.weights
    ?? (tasteProfile ? scaleForTaste(DEFAULT_WEIGHTS, TASTE_WEIGHT) : undefined);

  const ranked = rankBooks(
    {
      candidates,
      ...(queryVector !== undefined ? { queryVector, store } : {}),
      ...(tasteProfile && tasteStore
        ? { tastePrior: (book: Book) => tasteScoreFor(tasteProfile, tasteStore, book.id) }
        : {}),
      receptionPrior,
      ...(preferredTags !== undefined ? { preferredTags } : {}),
      ...(resolved.softExcludeTags !== undefined ? { softExcludeTags: resolved.softExcludeTags } : {}),
      ...(rankWeights !== undefined ? { weights: rankWeights } : {}),
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
    personalized: tasteProfile !== null,
    ...(resolutionNotes.length > 0 ? { tagResolution: resolutionNotes } : {}),
    ...libraryCoverage({ db: deps.db, embeddingModel: deps.embeddingModel }),
  };
}

// ── tag_coverage ─────────────────────────────────────────────────────────────

const tagCoverageFilterSchema = z.object({
  tag: tagSchema,
  category: tagCategorySchema.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
});
const tagCoverageInputSchema = z.object({
  tags: z.array(tagCoverageFilterSchema).min(1).max(MAX_FILTER_ITEMS),
  /** Restrict the report to this candidate set (e.g. a prior search's
   *  results). Omitted means "every active book". */
  bookIds: z.array(idSchema).max(MAX_CANDIDATE_BOOK_IDS).optional(),
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
      'Search by free-form vibe or prose — "melancholic coastal autumn", not a tag list. `author`, `allTags`, `anyTags`, `excludeTags`, `trustedOnly`, duration range (hours), series membership, and published-year range are ABSOLUTE hard filters applied before any scoring: a book that fails one is never returned, no matter how well `query` matches its description, and there is no retry if the filters return nothing. Use `allTags` only for an explicit absolute positive requirement the user stated outright; put ordinary free-form positive traits — genre, mood, tone, setting, pacing — in `preferredTags` instead, since they only re-rank and cannot empty the candidate set on thin tag coverage. `excludeTags` is a hard ban that considers every provenance. `preferredTags` and `softExcludeTags` only re-rank. If `semanticScored` is well below `results.length`, disclose that the order leaned on tags. Every supplied tag is normalized against the library vocabulary. When `tagResolution` is present, disclose material changes.',
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
