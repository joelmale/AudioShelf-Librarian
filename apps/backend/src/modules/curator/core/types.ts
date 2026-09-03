/**
 * Shared contract for the entire project.
 *
 * Per the plan this file is the single source of truth consumed by `core/`,
 * `api/`, and `mcp/`. It FREEZES at the end of Phase 3 — after that, any change
 * here is a breaking change requiring explicit review.
 *
 * Contents:
 *   1. Domain interfaces mirroring the SQLite schema.
 *   2. Zod schemas for runtime validation of ABS API responses.
 *   3. Zod schemas + interfaces for Claude tagging / collection IO.
 *   4. Operation result + progress types shared across api/mcp.
 */
import { z } from 'zod';

import type { EntityKind } from './enrichment/types.js';
import type { TitleParse } from './enrichment/titleParse.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tag taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const TAG_CATEGORIES = [
  'genre',
  'mood',
  'theme',
  'era',
  'pacing',
  'length',
  'audience',
  'trope',
  'structure',
  'character',
  'setting',
] as const;

export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** Categories every well-tagged book must populate (Task 2.6). */
export const REQUIRED_TAG_CATEGORIES: readonly TagCategory[] = [
  'genre',
  'mood',
  'pacing',
  'length',
] as const;

export const tagCategorySchema = z.enum(TAG_CATEGORIES);

/**
 * Version of the tag schema — i.e. of {@link TAG_CATEGORIES} — that a
 * tagging run attempted. Bump this integer whenever {@link TAG_CATEGORIES}
 * gains or loses a member.
 *
 * `tag_runs` (librarian engine plan §10.A) records, per book, both the
 * categories a run attempted AND the schema version current at the time. A
 * run always attempts the full `TAG_CATEGORIES` set as it existed when the
 * run happened, so a category added AFTER a book's most recent run simply
 * never appears in that book's recorded `categories` — the union computed
 * by `getAuditedCategories` naturally excludes it, and `getTagCoverage`
 * reports the book as `unaudited` for that category rather than `absent`.
 * The version number itself is not consulted by that logic; it exists as an
 * explicit, human-readable audit trail alongside the derived behaviour, so
 * "this book's latest run predates the current schema" can be answered by
 * inspection instead of by re-deriving it from category-set membership.
 *
 * Starts at 1: `TAG_CATEGORIES` as currently defined IS schema version 1's
 * full set. The next time a category is added or removed, bump this
 * constant — every run recorded from then on carries the new version, while
 * existing `tag_runs` rows keep their old one. That is exactly the honest
 * record we want: they attempted what they attempted, not what the schema
 * later became.
 */
export const TAG_SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Domain interfaces (SQLite mirror)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provenance for a harvested (non-ABS) description written to
 * {@link Book.descriptionEnriched} by the cache-only description-backfill
 * pass — never by ABS sync. This array — not a standalone union — is the
 * single source of truth: {@link DescriptionSource} is derived FROM it
 * (`typeof DESCRIPTION_SOURCES[number]`), so a slice that adds a member to
 * one but not the other fails to typecheck instead of silently drifting.
 * (Previously the type was declared first and this array separately
 * annotated `readonly DescriptionSource[]` — that ordering let a widened
 * union coexist with a stale runtime array and still compile; inverting it
 * removes that class of error entirely.) It also backs the runtime
 * validation `core/db.ts#mapBook` does on a decoded column value, the same
 * way {@link TagSource} does.
 *
 * Deliberately does NOT include `'abs'`: {@link Book.descriptionEnriched} and
 * this field are written only by `CuratorDb#setEnrichedDescription`, which is
 * documented as never touching ABS's own text, so `'abs'` is not a value the
 * writer contract can legitimately produce here. It is also a different
 * concept from the *effective* description source — resolved by
 * `core/enrichment/descriptionText.ts#resolveDescription`, which can and does
 * fall back to ABS — so conflating the two by adding `'abs'` to this type
 * would make it ambiguous which concept a given value means.
 *
 * Ordering here is NOT the retrieval-precedence ordering — that is a
 * separate, deliberately-argued decision owned by
 * `core/enrichment/descriptionText.ts#DESCRIPTION_SOURCE_PRECEDENCE`. This
 * array only needs to contain the same four members as that one (enforced by
 * a runtime set-equality test, since TypeScript cannot prove precedence
 * exhaustiveness against a derived union).
 */
export const DESCRIPTION_SOURCES = ['audnexus', 'wikidata', 'googlebooks', 'openlibrary'] as const;

export type DescriptionSource = (typeof DESCRIPTION_SOURCES)[number];

export interface Book {
  id: string; // ABS book ID
  title: string;
  author: string | null;
  series: string | null;
  seriesSequence: number | null;
  durationSeconds: number | null;
  publishedYear: number | null;
  genres: string[]; // decoded from the JSON column
  /**
   * Audiobookshelf's own description for this book, mirrored verbatim by
   * `upsertBook` on every sync. This is the ABS mirror and NOTHING ELSE — no
   * enrichment pass may ever write it, because `upsertBook` overwrites it
   * unconditionally from ABS on the very next sync, which would silently
   * erase any other writer. Provider-harvested text lives in
   * {@link descriptionEnriched}/{@link descriptionSource} instead; the single
   * effective description a consumer should actually read is resolved by
   * `core/enrichment/descriptionText.ts#resolveDescription`, not by reading
   * this field directly.
   */
  description: string | null;
  coverPath: string | null;
  absAddedAt: number | null;
  lastSyncedAt: number;
  libraryId?: string | null;
  itemPath?: string | null;
  asin?: string | null;
  isbn?: string | null;
  absUpdatedAt?: number | null;
  lastSeenSyncId?: string | null;
  syncStatus?: 'active' | 'deleted';
  deletedAt?: number | null;
  /** Parsed best-guess title from the filename-derived `title`. `title` itself is NEVER modified. */
  normalizedTitle?: string | null;
  /** Full parse result (candidates, author, year, ordinal, confidence) — survives for later re-processing. */
  titleParse?: TitleParse | null;
  /** Provenance for fields harvested from the title parse, e.g. `{"author":"title-parse"}`. */
  titleMetaSource?: Record<string, string> | null;
  /**
   * Cleaned provider-harvested description text, written only by the
   * cache-only description-backfill pass (never by ABS sync). Null when no
   * eligible cached candidate has been found for this book. Paired 1:1 with
   * {@link descriptionSource} — the two are always written or cleared
   * together via `CuratorDb#setEnrichedDescription`.
   */
  descriptionEnriched?: string | null;
  /**
   * Which provider {@link descriptionEnriched} came from. The WRITER
   * invariant is that `CuratorDb#setEnrichedDescription` always writes or
   * clears both columns together, so under normal operation this is null iff
   * `descriptionEnriched` is null. That pair can still disagree on READ,
   * though, in exactly one window: a value written by a newer build (one
   * that recognises a `DescriptionSource` member this build does not) is
   * read by an older build. `core/db.ts#mapBook` validates the stored source
   * against {@link DESCRIPTION_SOURCES} and decodes an unrecognised value to
   * null while passing `descriptionEnriched` through verbatim — so in that
   * window `descriptionEnriched` is authoritative and this field degrades to
   * "unknown provenance" rather than being trusted unchecked or discarding
   * the text. `descriptionText.ts#resolveDescription` still returns the text
   * with `source: null`, so no consumer loses the description over this on
   * READ — retrieval and `card_hash` stay exactly as they were.
   *
   * The very next description-backfill run is a DIFFERENT story: it is NOT
   * neutral if the older build's `providers` array lacks (or has not yet
   * implemented `extractDescription` for) the source that produced the
   * rolled-back-past value. `computeDescriptionWinner` then finds no
   * eligible candidate for that book, and the caller clears both columns —
   * see `descriptionBackfill.ts`'s module docblock — which DOES change
   * `resolveDescription`'s output and DOES invalidate `card_hash`, so the
   * book re-embeds. Concretely: ship a widened member (e.g. R5's
   * `'wikidata'`), run a full-library backfill campaign that attributes many
   * books to it, then roll the deploy back — the old build's first backfill
   * run after that wipes `description_enriched` for every one of those books
   * and re-embeds them. So "re-establishes the pair" (re-attributing to a
   * candidate the running build's providers can see, or clearing both
   * columns together if none is eligible) can mean "clears and pays for a
   * library-scale re-embed," not merely "leaves alone" — a cost the R5/R8
   * briefs need to carry as an explicit rollback risk, not just an inert
   * read-time degradation. In short:
   * `description_source` is open-set on read (an unrecognised stored value
   * is tolerated and degrades gracefully) and closed-set on write (the
   * writer only ever stores a currently-recognised {@link DescriptionSource}).
   */
  descriptionSource?: DescriptionSource | null;
  /**
   * Narrator(s) for this audiobook, as a list — never a joined string, so a
   * full-cast production is distinguishable from a single narrator.
   * Populated from ABS's `narratorName` on every sync (JSON-encoded exactly
   * the way {@link genres} is) and updatable independently via
   * `CuratorDb#setNarrator` for a cache-only enrichment pass. Null means no
   * narrator is known, distinct from an empty list.
   */
  narrator?: string[] | null;
}

/** Provenance of a tag — determines trust tier for filtering. */
export type TagSource = 'vocab' | 'derived' | 'llm-open' | 'abs' | `external:${string}`;

export interface BookTag {
  id: number;
  bookId: string;
  tag: string;
  category: TagCategory;
  confidence: number; // 0.0–1.0
  taggedAt: number;
  /** Provenance of this tag. 'llm-open' means unconfirmed LLM output, excluded from hard filters. */
  source: TagSource;
}

/**
 * One record of a tagging run — what it ATTEMPTED for a book, not what it
 * produced (librarian engine plan §10.A). `book_tags` alone cannot tell "no
 * trope tags because none apply" from "no trope tags because `trope` didn't
 * exist yet when this book was last tagged"; `tag_runs` is what makes that
 * distinction possible. Re-tag history is genuinely a list, so this is its
 * own table rather than a JSON column on `books` — a book accumulates one
 * row per run, oldest to newest.
 */
export interface TagRun {
  id: number;
  bookId: string;
  /** Every category this run attempted, regardless of whether it found anything. */
  categories: TagCategory[];
  /** {@link TAG_SCHEMA_VERSION} at the time this run happened. */
  schemaVersion: number;
  taggedAt: number;
}

/** Result of an enrichment provider lookup, cached per (bookId, provider). */
export type ExternalMetadataStatus = 'ok' | 'not-found' | 'error';

/** Cached raw response from an enrichment provider (librarian engine plan §1.2). */
export interface ExternalMetadataRecord {
  bookId: string;
  provider: string; // 'openlibrary' | 'audnexus' | ...
  payload: unknown; // parsed from the JSON column; null for not-found/error
  fetchedAt: number;
  status: ExternalMetadataStatus;
}

/** A grounded entity (person/place/time) confirmed for a book by enrichment
 *  providers — the validation allowlist for entity tags (librarian engine
 *  plan §1.3). Never written by the tagger directly.
 *
 *  `book_entities` serves two purposes with opposite needs: validation
 *  (`tagging/ground.ts` rejecting fabricated characters) wants every entity
 *  ever seen, however large the list; presentation (the book card, entity
 *  display) wants only the small notable subset. Rather than maintaining two
 *  tables, every entity is kept and `notable` flags the subset worth
 *  surfacing (see `enrichment/entityNotability.ts`). Nothing is ever deleted
 *  for being non-notable. */
export interface BookEntity {
  bookId: string;
  entity: string; // canonical form, e.g. 'Benjamin Hanscom'
  kind: EntityKind;
  sources: string[]; // provider names that confirmed it
  /** True when this entity is part of the small, high-precision subset meant
   *  for display (card text, UI). False entities are still real and still
   *  used for validation — see the interface docblock. */
  notable: boolean;
}

/** Lifecycle state of a vocabulary term (librarian engine plan §1.4). */
export type VocabTermStatus = 'seed' | 'proposed' | 'promoted' | 'rejected';

/**
 * Which pass proposed a `status='proposed'` vocabulary term (R1,
 * docs/enrichment-sources-review.md §3): `'tagger'` for the LLM's llm-open
 * output (`CuratorDb#refreshProposedVocabCounts`), `'enrichment'` for cached
 * provider subjects (`core/enrichment/promoteSubjects.ts`,
 * `CuratorDb#refreshEnrichmentVocabProposals`). Meaningful ONLY for
 * `status='proposed'` rows — `seed`/`promoted`/`rejected` rows carry the
 * default and nothing consults it there.
 */
export type VocabTermOrigin = 'tagger' | 'enrichment';

/** A tag-taxonomy vocabulary entry: either a curated seed term, or an
 *  llm-open tag proposed for promotion by usage volume. */
export interface VocabTerm {
  term: string;
  category: TagCategory;
  status: VocabTermStatus;
  bookCount: number;
  firstSeen: number;
  origin: VocabTermOrigin;
}

export interface VocabReviewItem {
  term: string;
  category: TagCategory;
}

export type VocabBatchAction = 'promote' | 'reject';

export interface VocabBatchResult {
  action: VocabBatchAction;
  reviewed: number;
  retagged: number;
  bookIds: string[];
  missing: VocabReviewItem[];
  collisions: VocabReviewItem[];
}

/** Maps a raw/normalized alias to its canonical vocabulary term within a category. */
export interface TagAlias {
  alias: string;
  canonical: string;
  category: TagCategory;
}

/** Similarity edge kinds (librarian engine plan §1.5). 'similar' is
 *  embedding-neighbour similarity within the library; 'comparable' is a
 *  readalike, which may point at a work the user does not own — see the
 *  `ext:<normalized-title>|<normalized-author>` key convention in
 *  externalKey.ts, the only place that key may be minted. */
export type EdgeRelation = 'similar' | 'comparable';

/** How an edge was derived. */
export type EdgeSource = 'embedding' | 'llm' | 'feedback';

/** A book's card embedding. `cardHash` is the hash of the composed card text
 *  and drives re-embedding: a book is re-embedded only when its card text or
 *  the embedding model changed. */
export interface BookEmbedding {
  bookId: string;
  model: string;
  cardHash: string;
  vector: Float32Array;
}

export interface BookEdge {
  fromBook: string;
  /** May reference a non-owned work, so never assume books(id). A non-owned
   *  reference is an "external key" minted by `externalBookKey` in
   *  externalKey.ts — always `ext:<normalized-title>|<normalized-author>`.
   *  Check with `isExternalBookKey` before treating this as a `books.id`. */
  toBook: string;
  relation: EdgeRelation;
  score: number | null;
  source: EdgeSource;
}

export type CollectionStatus = 'proposed' | 'approved' | 'pushed' | 'rejected';

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  theme: string; // template id or custom prompt used to generate
  status: CollectionStatus;
  absCollectionId: string | null;
  createdAt: number;
  pushedAt: number | null;
  libraryId?: string | null;
  ownershipMarker?: string | null;
}

export interface CollectionBook {
  collectionId: number;
  bookId: string;
  sortOrder: number | null;
}

export type SyncOperation = 'sync' | 'tag' | 'generate' | 'push' | 'encode' | 'enrich' | 'embed' | 'title-parse';
export type SyncStatus = 'running' | 'success' | 'error';

export interface SyncLogEntry {
  id: number;
  operation: SyncOperation;
  status: SyncStatus;
  detail: unknown | null; // decoded from the JSON column
  startedAt: number;
  finishedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ABS API response schemas (runtime validation)
//
// ABS response shapes vary across versions and between "minified"/"expanded"
// payloads, so item internals are validated leniently (.passthrough(), optional
// fields) while the *envelopes* (results array, pagination counters) are strict
// — those are what the pagination + sync logic depends on.
// ─────────────────────────────────────────────────────────────────────────────

export const absLibrarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mediaType: z.string().optional(),
  })
  .passthrough();
export type ABSLibrary = z.infer<typeof absLibrarySchema>;

export const absLibrariesResponseSchema = z.object({
  libraries: z.array(absLibrarySchema),
});

export const absSeriesEntrySchema = z
  .object({
    name: z.string(),
    sequence: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

export const absBookMetadataSchema = z
  .object({
    title: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
    authorName: z.string().nullable().optional(),
    narratorName: z.string().nullable().optional(),
    seriesName: z.string().nullable().optional(),
    series: z.array(absSeriesEntrySchema).optional(),
    genres: z.array(z.string()).nullable().optional(),
    publishedYear: z.union([z.string(), z.number()]).nullable().optional(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    asin: z.string().nullable().optional(),
    isbn: z.string().nullable().optional(),
  })
  .passthrough();

export const absMediaSchema = z
  .object({
    metadata: absBookMetadataSchema,
    coverPath: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
  })
  .passthrough();

export const absLibraryItemSchema = z
  .object({
    id: z.string(),
    mediaType: z.string().optional(),
    media: absMediaSchema,
    addedAt: z.number().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
    path: z.string().nullable().optional(),
  })
  .passthrough();
export type ABSLibraryItem = z.infer<typeof absLibraryItemSchema>;

export const absLibraryItemsResponseSchema = z
  .object({
    results: z.array(absLibraryItemSchema),
    total: z.number(),
    limit: z.number(),
    page: z.number(),
  })
  .passthrough();

export const absCollectionSchema = z
  .object({
    id: z.string(),
    libraryId: z.string().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
  })
  .passthrough();
export type ABSCollection = z.infer<typeof absCollectionSchema>;

export const absCollectionsResponseSchema = z.object({
  collections: z.array(absCollectionSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Claude IO schemas
// ─────────────────────────────────────────────────────────────────────────────

export const generatedTagSchema = z.object({
  tag: z.string().min(1).max(60),
  category: tagCategorySchema,
  confidence: z.number().min(0).max(1),
});
export type GeneratedTag = z.infer<typeof generatedTagSchema>;

/** Required JSON shape Claude must return for tagging a single book. */
export const tagResponseSchema = z.object({
  tags: z.array(generatedTagSchema),
});
export type TagResponse = z.infer<typeof tagResponseSchema>;

/** Required JSON shape Claude must return for a custom collection. */
export const collectionProposalSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().default(''),
  bookIds: z.array(z.string()),
  reasoning: z.string().optional(),
});
export type CollectionProposal = z.infer<typeof collectionProposalSchema>;

export const recommendationCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().min(1).max(160),
  reason: z.string().min(1).max(500),
});

export const recommendationResponseSchema = z.object({
  interpretation: z.string().min(1).max(500),
  constraints: z.object({
    maxDurationHours: z.number().positive().max(100).nullable(),
    genres: z.array(z.string().min(1).max(60)).max(8),
    moods: z.array(z.string().min(1).max(60)).max(8),
  }),
  shelf: z.array(z.object({
    bookId: z.string().min(1),
    reason: z.string().min(1).max(500),
  })).max(12),
  external: z.array(recommendationCandidateSchema).max(12),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

export const multiCollectionProposalSchema = z.object({
  collections: z.array(collectionProposalSchema),
});
export type MultiCollectionProposal = z.infer<typeof multiCollectionProposalSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export interface BookTagResult {
  bookId: string;
  tags: GeneratedTag[];
  usage: TokenUsage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Operation result + progress types
// ─────────────────────────────────────────────────────────────────────────────

export interface OperationError {
  /** Identifier of the unit that failed (bookId, libraryId, …) when applicable. */
  id?: string;
  code: string;
  message: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
  errors: OperationError[];
  tombstoned?: number;
  restored?: number;
  libraries?: Array<{ libraryId: string; status: 'success' | 'error'; total: number; tombstoned: number }>;
}

export interface TaggingResult {
  processed: number;
  skipped: number;
  failed: number;
  errors: OperationError[];
  tokensUsed: TokenUsage;
  dryRun: boolean;
  /** Present on a dry run: the books that would have been tagged. */
  plan?: TaggingPlanEntry[];
  /** True when the run was cancelled before completing all candidates. */
  cancelled?: boolean;
  /**
   * Ids of the books this run actually wrote tags for (empty on a dry run).
   * Lets a caller scope a follow-up operation — the readiness-plan item B
   * re-embed — to exactly the books that changed, instead of the whole
   * candidate pool or the whole library.
   */
  processedBookIds: string[];
}

/** Per-book entry returned by a dry run (no API calls made). */
export interface TaggingPlanEntry {
  bookId: string;
  title: string;
}

/** Compact, token-efficient book representation fed to Claude for collections. */
export interface TagSummaryBook {
  id: string;
  title: string;
  author: string | null;
  durationHr: number | null;
  tags: Partial<Record<TagCategory, string[]>>;
}

export type TagSummary = TagSummaryBook[];

export type ConflictPolicy = 'skip' | 'overwrite' | 'rename';

export interface PushResult {
  collectionId: number;
  absCollectionId: string;
  action: 'created' | 'updated' | 'skipped' | 'renamed';
  finalName: string;
}

/** Progress callback shared by core ops; api wraps as SSE, mcp as notifications. */
export interface ProgressUpdate {
  phase: string;
  current: number;
  total: number;
  message?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => void;

// ── Feedback & personalization (librarian engine plan §6, Migration E) ──────

/**
 * What happened to a recommendation.
 *
 * `accepted`/`rejected` are explicit — the user pressed something. `finished`
 * and `abandoned` are implicit, derived from Audiobookshelf listening
 * progress by `core/feedback/listeningSignals.ts`. A personal library is a
 * positive-only dataset (every book in it was chosen), so `abandoned` is the
 * only true negative this system will ever observe about an owned book —
 * see `docs/recommendation-data-model.md` §2.
 */
export const FEEDBACK_VERDICTS = ['accepted', 'rejected', 'finished', 'abandoned'] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export type FeedbackSource = 'explicit' | 'implicit';

export interface RecFeedback {
  id: number;
  /** Null for a non-owned (external) recommendation. */
  bookId: string | null;
  /** `title|author`, normalized — set only when `bookId` is null. */
  externalKey: string | null;
  queryText: string;
  verdict: FeedbackVerdict;
  source: FeedbackSource;
  /**
   * Graded strength in (0,1]. An implicit verdict carries how far the user
   * actually got: abandoned at 8% is a strong reject, abandoned at 80% is
   * nearly a completion. Explicit verdicts are always 1.
   */
  weight: number;
  createdAt: number;
}

/**
 * One row of a slate that was actually shown, with the rank it was shown at.
 *
 * Verdicts alone say what was accepted; they do not say what it was accepted
 * *over*. Recording the whole slate is what turns "did the ranker put the
 * winner at rank 1?" into an offline NDCG/MRR measurement over real history,
 * instead of a human judgment call for every weight change (plan §10.C).
 */
export interface RecImpression {
  id: number;
  /** Groups the rows of one slate. */
  slateId: string;
  queryText: string;
  bookId: string | null;
  externalKey: string | null;
  /** 0-based position as displayed. */
  rank: number;
  /** Ranker score at display time, when known. */
  score: number | null;
  shownAt: number;
}

/** Last observed Audiobookshelf progress for one owned book. A snapshot: overwritten, never appended. */
export interface ListeningProgress {
  bookId: string;
  /** 0..1. */
  progress: number;
  isFinished: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** Seconds actually played, which is not the same as `progress * duration`. */
  timeListening: number;
  lastPlayedAt: number | null;
  updatedAt: number;
}

/**
 * One Audiobookshelf listening session. Append-only and keyed by the ABS
 * session id so a re-sync is idempotent. `startedAt` + `duration` are what
 * make the situational archetype measurable rather than inferred — "commute
 * books" becomes *consumed in 25–45 minute weekday-morning sessions*.
 */
export interface ListeningSession {
  id: string;
  bookId: string;
  startedAt: number;
  /** Seconds of this one session. */
  duration: number;
  /** 2.0 means "getting through it"; 1.0 means "savouring". */
  playbackSpeed: number | null;
  device: string | null;
}

/**
 * Audiobookshelf `/api/me` media-progress entry. `.passthrough()` throughout
 * because ABS adds fields between versions and a strict schema would turn a
 * server upgrade into a sync outage.
 */
export const absMediaProgressSchema = z
  .object({
    id: z.string().optional(),
    libraryItemId: z.string(),
    progress: z.number().nullable().optional(),
    isFinished: z.boolean().nullable().optional(),
    currentTime: z.number().nullable().optional(),
    duration: z.number().nullable().optional(),
    startedAt: z.number().nullable().optional(),
    finishedAt: z.number().nullable().optional(),
    lastUpdate: z.number().nullable().optional(),
    timeListening: z.number().nullable().optional(),
  })
  .passthrough();

export const absMeResponseSchema = z
  .object({ mediaProgress: z.array(absMediaProgressSchema).nullable().optional() })
  .passthrough();

export const absListeningSessionSchema = z
  .object({
    id: z.string(),
    libraryItemId: z.string().nullable().optional(),
    startedAt: z.number().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
    timeListening: z.number().nullable().optional(),
    playbackSpeed: z.number().nullable().optional(),
    deviceInfo: z
      .object({ deviceType: z.string().nullable().optional(), model: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const absListeningSessionsResponseSchema = z
  .object({
    sessions: z.array(absListeningSessionSchema).nullable().optional(),
    total: z.number().nullable().optional(),
  })
  .passthrough();
