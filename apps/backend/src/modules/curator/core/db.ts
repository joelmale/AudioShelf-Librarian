/**
 * SQLite connection, migrations, and typed per-table query helpers.
 *
 * better-sqlite3 is fully synchronous, so every write executes atomically on the
 * Node event loop — this is the "single writer" that the rate-limited worker pool
 * funnels into (adversarial case C1). WAL is enabled so reads never block writes.
 *
 * The schema created here is the canonical schema from the plan, verbatim.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { DBError } from './errors.js';
import type {
  EncodeQueueItem,
  EncodeHistoryItem,
  EncodeJobStatus,
  NewEncodeQueueItem,
  NewEncodeHistoryItem,
  EncodeCandidate,
} from './encoder/encodeTypes.js';
import type { EntityKind } from './enrichment/types.js';
import type { TitleParse } from './enrichment/titleParse.js';
import type { ConversationStatus, LibrarianEvent } from './librarian/events.js';
import { librarianEventSchema } from './librarian/events.js';
import type {
  Book,
  BookEdge,
  BookEmbedding,
  BookEntity,
  BookTag,
  Collection,
  CollectionBook,
  CollectionStatus,
  DescriptionSource,
  EdgeRelation,
  EdgeSource,
  ExternalMetadataRecord,
  ExternalMetadataStatus,
  FeedbackSource,
  FeedbackVerdict,
  GeneratedTag,
  ListeningProgress,
  ListeningSession,
  RecFeedback,
  RecImpression,
  SyncLogEntry,
  SyncOperation,
  SyncStatus,
  TagAlias,
  TagCategory,
  TagRun,
  TagSource,
  VocabTerm,
  VocabBatchAction,
  VocabBatchResult,
  VocabReviewItem,
  VocabTermStatus,
} from './types.js';
import { DESCRIPTION_SOURCES } from './types.js';
import { SEED_VOCABULARY } from './vocabulary.js';

// ── Raw row shapes (snake_case, as stored) ───────────────────────────────────

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
  series_sequence: number | null;
  duration_seconds: number | null;
  published_year: number | null;
  genres: string | null;
  description: string | null;
  cover_path: string | null;
  abs_added_at: number | null;
  last_synced_at: number;
  library_id: string | null; item_path: string | null; asin: string | null; isbn: string | null;
  abs_updated_at: number | null; last_seen_sync_id: string | null; sync_status: string; deleted_at: number | null;
  normalized_title: string | null; title_parse: string | null; title_meta_source: string | null;
  description_enriched: string | null; description_source: string | null; narrator: string | null;
}

interface BookTagRow {
  id: number;
  book_id: string;
  tag: string;
  category: string;
  confidence: number;
  tagged_at: number;
  source: string;
}

interface TagRunRow {
  id: number;
  book_id: string;
  categories: string; // JSON array of TagCategory
  schema_version: number;
  tagged_at: number;
}

interface ConversationRow {
  id: string;
  thread_id: string | null;
  question: string | null;
  turn_index: number | null;
  status: string;
  started_at: number;
  updated_at: number;
}

interface ConversationThreadRow {
  id: string;
  created_at: number;
  updated_at: number;
}

interface ConversationEventRow {
  conversation_id: string;
  seq: number;
  /** The event's own discriminant, denormalized out of `payload` at write
   *  time by the single writer, so the table is legible to an operator with
   *  a sqlite3 prompt. Never the source of truth — `payload` is. */
  type: string;
  /** JSON of the whole `LibrarianEvent`, `type` included. */
  payload: string;
  recorded_at: number;
}

interface ConversationDetailRow extends ConversationRow {
  event_seq: number | null;
  event_type: string | null;
  event_payload: string | null;
  event_recorded_at: number | null;
}

interface CollectionRow {
  id: number;
  name: string;
  description: string | null;
  theme: string;
  status: string;
  abs_collection_id: string | null;
  created_at: number;
  pushed_at: number | null;
  library_id: string | null;
  ownership_marker: string | null;
}

interface CollectionBookRow {
  collection_id: number;
  book_id: string;
  sort_order: number | null;
}

interface SyncLogRow {
  id: number;
  operation: string;
  status: string;
  detail: string | null;
  started_at: number;
  finished_at: number | null;
}

interface ExternalMetadataRow {
  book_id: string;
  provider: string;
  payload: string | null;
  fetched_at: number;
  status: string;
}

interface BookEntityRow {
  book_id: string;
  entity: string;
  kind: string;
  sources: string;
  notable: number;
}

interface BookEmbeddingRow {
  book_id: string;
  model: string;
  card_hash: string;
  vector: Buffer;
}

/** Row shape of `getStaleEmbeddings`'s `books LEFT JOIN book_embeddings` query:
 *  every `books` column plus the joined embedding's identity (null when the
 *  LEFT JOIN found no matching row, i.e. the book has never been embedded). */
interface StaleEmbeddingRow extends BookRow {
  embedding_model: string | null;
  embedding_card_hash: string | null;
}

interface BookEdgeRow {
  from_book: string;
  to_book: string;
  relation: string;
  score: number | null;
  source: string;
}

interface TagAliasRow {
  alias: string;
  canonical: string;
  category: string;
}

interface RecFeedbackRow {
  id: number;
  book_id: string | null;
  external_key: string | null;
  query_text: string;
  verdict: string;
  source: string;
  weight: number;
  created_at: number;
}

interface RecImpressionRow {
  id: number;
  slate_id: string;
  query_text: string;
  book_id: string | null;
  external_key: string | null;
  rank: number;
  score: number | null;
  shown_at: number;
}

interface ListeningProgressRow {
  book_id: string;
  progress: number;
  is_finished: number;
  started_at: number | null;
  finished_at: number | null;
  time_listening: number;
  last_played_at: number | null;
  updated_at: number;
}

interface ListeningSessionRow {
  id: string;
  book_id: string;
  started_at: number;
  duration: number;
  playback_speed: number | null;
  device: string | null;
}

interface VocabTermRow {
  term: string;
  category: string;
  status: string;
  book_count: number;
  first_seen: number;
  origin: string;
  tagger_book_count: number;
  enrichment_book_count: number;
}

interface EncodeQueueRow {
  id: string;
  library_id: string;
  name: string;
  author: string | null;
  total_bytes: number;
  status: string;
  sort_order: number;
  added_at: number;
  detail: string | null;
}

interface EncodeHistoryRow {
  id: number;
  library_item_id: string;
  name: string;
  author: string | null;
  total_bytes: number;
  status: string;
  started_at: number;
  finished_at: number | null;
  detail: string | null;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapBook(row: BookRow): Book {
  let genres: string[] = [];
  if (row.genres) {
    try {
      const parsed: unknown = JSON.parse(row.genres);
      if (Array.isArray(parsed)) genres = parsed.filter((g): g is string => typeof g === 'string');
    } catch {
      genres = [];
    }
  }
  let titleParse: TitleParse | null = null;
  if (row.title_parse) {
    try {
      titleParse = JSON.parse(row.title_parse) as TitleParse;
    } catch {
      titleParse = null;
    }
  }
  let titleMetaSource: Record<string, string> | null = null;
  if (row.title_meta_source) {
    try {
      const parsed: unknown = JSON.parse(row.title_meta_source);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        titleMetaSource = parsed as Record<string, string>;
      }
    } catch {
      titleMetaSource = null;
    }
  }
  // Same decode idiom as `genres` above, except absence stays `null` rather
  // than defaulting to `[]` — no narrator known is a different fact from a
  // known-empty narrator list, and ABS's own `narratorName` is itself optional.
  let narrator: string[] | null = null;
  if (row.narrator) {
    try {
      const parsed: unknown = JSON.parse(row.narrator);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((n): n is string => typeof n === 'string');
        // Never surface `[]` — every writer of this column (upsertBook,
        // setNarrator) deliberately stores NULL instead of an empty array,
        // and Book's own contract (types.ts) says an empty list means
        // "known-empty", a fact those writers never assert. A stored value
        // that decodes to zero usable strings (e.g. hand-edited to '[]' or
        // '[5]') is therefore "nothing known", same as no row at all.
        narrator = filtered.length > 0 ? filtered : null;
      }
    } catch {
      narrator = null;
    }
  }
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    series: row.series,
    seriesSequence: row.series_sequence,
    durationSeconds: row.duration_seconds,
    publishedYear: row.published_year,
    genres,
    description: row.description,
    coverPath: row.cover_path,
    absAddedAt: row.abs_added_at,
    lastSyncedAt: row.last_synced_at,
    libraryId: row.library_id, itemPath: row.item_path, asin: row.asin, isbn: row.isbn,
    absUpdatedAt: row.abs_updated_at, lastSeenSyncId: row.last_seen_sync_id,
    syncStatus: row.sync_status as 'active' | 'deleted', deletedAt: row.deleted_at,
    normalizedTitle: row.normalized_title, titleParse, titleMetaSource,
    // Plain TEXT columns — passed through verbatim, no JSON parse needed.
    descriptionEnriched: row.description_enriched,
    // Validated like every other decoded column above (genres, titleParse,
    // titleMetaSource, narrator): a value written by a future or rolled-back
    // build that isn't a known DescriptionSource decodes to null rather than
    // being cast through unchecked.
    descriptionSource: (row.description_source && (DESCRIPTION_SOURCES as readonly string[]).includes(row.description_source))
      ? (row.description_source as DescriptionSource)
      : null,
    narrator,
  };
}

function mapBookTag(row: BookTagRow): BookTag {
  return {
    id: row.id,
    bookId: row.book_id,
    tag: row.tag,
    category: row.category as TagCategory,
    confidence: row.confidence,
    taggedAt: row.tagged_at,
    source: row.source as TagSource,
  };
}

function mapTagRun(row: TagRunRow): TagRun {
  let categories: TagCategory[] = [];
  if (row.categories) {
    try {
      const parsed: unknown = JSON.parse(row.categories);
      if (Array.isArray(parsed)) categories = parsed.filter((c): c is string => typeof c === 'string') as TagCategory[];
    } catch {
      categories = [];
    }
  }
  return {
    id: row.id,
    bookId: row.book_id,
    categories,
    schemaVersion: row.schema_version,
    taggedAt: row.tagged_at,
  };
}

function mapExternalMetadata(row: ExternalMetadataRow): ExternalMetadataRecord {
  let payload: unknown = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
  }
  return {
    bookId: row.book_id,
    provider: row.provider,
    payload,
    fetchedAt: row.fetched_at,
    status: row.status as ExternalMetadataStatus,
  };
}

function mapBookEntity(row: BookEntityRow): BookEntity {
  let sources: string[] = [];
  if (row.sources) {
    try {
      const parsed: unknown = JSON.parse(row.sources);
      if (Array.isArray(parsed)) sources = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      sources = [];
    }
  }
  return {
    bookId: row.book_id,
    entity: row.entity,
    kind: row.kind as EntityKind,
    sources,
    notable: row.notable === 1,
  };
}

/**
 * better-sqlite3 hands back a `Buffer` that may be a view into a shared,
 * pooled allocation — its `byteOffset` is frequently NOT a multiple of 4, so
 * `new Float32Array(buf.buffer, buf.byteOffset, n)` throws `RangeError:
 * start offset of Float32Array should be a multiple of 4`. Copy the bytes
 * out first so the Float32Array always views a freshly aligned ArrayBuffer.
 */
function bufferToFloat32Array(buf: Buffer): Float32Array {
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(bytes);
}

function mapBookEmbedding(row: BookEmbeddingRow): BookEmbedding {
  return {
    bookId: row.book_id,
    model: row.model,
    cardHash: row.card_hash,
    vector: bufferToFloat32Array(row.vector),
  };
}

function mapBookEdge(row: BookEdgeRow): BookEdge {
  return {
    fromBook: row.from_book,
    toBook: row.to_book,
    relation: row.relation as EdgeRelation,
    score: row.score,
    source: row.source as EdgeSource,
  };
}

function mapRecFeedback(row: RecFeedbackRow): RecFeedback {
  return {
    id: row.id,
    bookId: row.book_id,
    externalKey: row.external_key,
    queryText: row.query_text,
    verdict: row.verdict as FeedbackVerdict,
    source: row.source as FeedbackSource,
    weight: row.weight,
    createdAt: row.created_at,
  };
}

function mapRecImpression(row: RecImpressionRow): RecImpression {
  return {
    id: row.id,
    slateId: row.slate_id,
    queryText: row.query_text,
    bookId: row.book_id,
    externalKey: row.external_key,
    rank: row.rank,
    score: row.score,
    shownAt: row.shown_at,
  };
}

function mapListeningProgress(row: ListeningProgressRow): ListeningProgress {
  return {
    bookId: row.book_id,
    progress: row.progress,
    isFinished: row.is_finished !== 0,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    timeListening: row.time_listening,
    lastPlayedAt: row.last_played_at,
    updatedAt: row.updated_at,
  };
}

function mapListeningSession(row: ListeningSessionRow): ListeningSession {
  return {
    id: row.id,
    bookId: row.book_id,
    startedAt: row.started_at,
    duration: row.duration,
    playbackSpeed: row.playback_speed,
    device: row.device,
  };
}

function mapTagAlias(row: TagAliasRow): TagAlias {
  return {
    alias: row.alias,
    canonical: row.canonical,
    category: row.category as TagCategory,
  };
}

function mapVocabTerm(row: VocabTermRow): VocabTerm {
  return {
    term: row.term,
    category: row.category as TagCategory,
    status: row.status as VocabTermStatus,
    bookCount: row.book_count,
    firstSeen: row.first_seen,
    // Legacy rows predating the column default to 'tagger' at the SQL level
    // (see the `origin` migration), so this cast is safe without a runtime
    // check the way `description_source` needs one — there are exactly two
    // values and the column's own DEFAULT enforces one of them.
    origin: (row.origin === 'enrichment' ? 'enrichment' : 'tagger') as VocabTerm['origin'],
  };
}

function mapCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    theme: row.theme,
    status: row.status as CollectionStatus,
    absCollectionId: row.abs_collection_id,
    createdAt: row.created_at,
    pushedAt: row.pushed_at,
    libraryId: row.library_id,
    ownershipMarker: row.ownership_marker,
  };
}

function mapCollectionBook(row: CollectionBookRow): CollectionBook {
  return {
    collectionId: row.collection_id,
    bookId: row.book_id,
    sortOrder: row.sort_order,
  };
}

function mapSyncLog(row: SyncLogRow): SyncLogEntry {
  let detail: unknown = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
  }
  return {
    id: row.id,
    operation: row.operation as SyncOperation,
    status: row.status as SyncStatus,
    detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapEncodeQueueItem(row: EncodeQueueRow): EncodeQueueItem {
  let detail = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {}
  }
  return {
    id: row.id,
    libraryId: row.library_id,
    name: row.name,
    author: row.author || '',
    totalBytes: row.total_bytes,
    status: row.status as EncodeJobStatus,
    sortOrder: row.sort_order,
    addedAt: row.added_at,
    detail,
  };
}

function mapEncodeHistoryItem(row: EncodeHistoryRow): EncodeHistoryItem {
  let detail = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {}
  }
  return {
    id: row.id,
    libraryItemId: row.library_item_id,
    name: row.name,
    author: row.author || '',
    totalBytes: row.total_bytes,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    detail,
  };
}

// ── Query option shapes ───────────────────────────────────────────────────────

/** One tag predicate. `category` and `minConfidence` narrow it when present. */
export interface TagFilter {
  tag: string;
  category?: TagCategory;
  minConfidence?: number;
}

/** One grounded-entity predicate over `book_entities`. */
export interface EntityFilter {
  entity: string;
  kind?: EntityKind;
}

export interface BookQueryFilters {
  search?: string; // title/author LIKE
  author?: string;
  untagged?: boolean;
  tag?: string;
  category?: TagCategory;
  minConfidence?: number;
  limit?: number;
  offset?: number;
  libraryId?: string;

  /** Every one of these tags must be present (AND). */
  allTags?: TagFilter[];
  /** At least one of these tags must be present (OR). */
  anyTags?: TagFilter[];
  /** A book carrying ANY of these tags is excluded (hard predicate, never a score penalty). */
  excludeTags?: TagFilter[];
  /**
   * Restrict INCLUSION tag predicates (`tag`, `allTags`, `anyTags`) to trusted
   * provenance — `book_tags.source != 'llm-open'`. Default false, which
   * preserves today's behaviour exactly.
   *
   * **`excludeTags` deliberately ignores this flag** and always considers
   * every tag regardless of source. The two error directions are not
   * symmetric: over-excluding costs the reader one candidate they might have
   * enjoyed, while under-excluding violates a constraint they stated outright
   * ("absolutely zero chosen-one tropes"). Unverified evidence is weak
   * grounds *for* a book and sufficient grounds *against* one.
   *
   * A previous revision made the flag uniform across all predicates and
   * documented the resulting asymmetry as a call-site hazard, on the
   * reasonable argument that a SQL accessor should supply mechanism and let
   * the librarian's trust rules (plan §5.4) supply policy. That was overruled
   * deliberately: `queryBooks` is the boundary between a stated user
   * constraint and a recommendation, so it fails safe rather than fails
   * configurable. A documented footgun is still a footgun, and the tool layer
   * above this is agent-written.
   *
   * If a caller ever genuinely needs trusted-only exclusions (pruning a slate
   * where a low-confidence guess should not bury a good candidate), add an
   * explicit opt-in field for it. Do not re-widen this one — the unsafe
   * combination should be unreachable by accident.
   *
   * The accepted cost: a low-confidence `llm-open` tag can suppress a book
   * that does not really carry that trope. That is why the librarian pairs
   * exclusions with the coverage disclosure (plan §5.4, §8.6) rather than
   * presenting them as certainty.
   */
  trustedOnly?: boolean;

  /** Every one of these entities must be present (AND). */
  allEntities?: EntityFilter[];
  /** At least one of these entities must be present (OR). */
  anyEntities?: EntityFilter[];
}

export interface BookQueryResult {
  books: Book[];
  total: number;
  limit: number;
  offset: number;
}

export interface TagVocabularyEntry {
  tag: string;
  category: TagCategory;
  count: number;
}

/** Maximum book ids kept per bucket in a {@link TagCoverageEntry}. `count` is
 *  always the exact, uncapped total; `bookIds` is a sample for display —
 *  large libraries would otherwise return thousands of ids per tag. */
export const TAG_COVERAGE_ID_CAP = 50;

/** One bucket of a {@link TagCoverageEntry} — an exact count plus a capped
 *  sample of the book ids in it (see {@link TAG_COVERAGE_ID_CAP}). */
export interface TagCoverageBucket {
  count: number;
  bookIds: string[];
}

/**
 * Three-state coverage classification for one requested tag over the
 * candidate set (librarian engine plan §10.A). Every candidate book lands in
 * exactly one bucket:
 *  - `present`   — the book carries the tag (matching `category`/`minConfidence`
 *                  when given). NOTE: a `book_tags` row that exists but falls
 *                  below `minConfidence` does NOT count as present — it
 *                  classifies as `absent` below, which is consistent with the
 *                  query predicate but can read as "doesn't carry it" when a
 *                  row for it does in fact exist.
 *  - `absent`    — the book does not carry it, its category WAS audited for
 *                  this book (per {@link CuratorDb.getAuditedCategories}), AND
 *                  the book currently has at least one `book_tags` row — a
 *                  book whose tags were wiped after being tagged (a failed
 *                  retag, or a direct tag-clear) falls to `unaudited` instead,
 *                  because its stale `tag_runs` history no longer describes
 *                  evidence that exists.
 *  - `unaudited` — the book does not carry it, AND that category was never
 *                  attempted for this book — including every book tagged
 *                  before the category existed, every untagged book, and
 *                  every book whose tags were cleared after tagging.
 *
 * A requested id that is tombstoned or does not exist is dropped from the
 * candidate set entirely and so appears in none of the three buckets —
 * `present.count + absent.count + unaudited.count` can therefore be less
 * than the requested id count; that is not a bug to reconcile.
 */
export interface TagCoverageEntry {
  tag: string;
  /**
   * The category this predicate resolved to. Equal to the filter's
   * `category` when given; otherwise derived from recorded usage of `tag`.
   * `null` when it cannot be determined at all (an unused tag with no
   * `category` given) or is ambiguous (the same tag string recorded under
   * more than one category) — in that case every non-present book in this
   * entry is classified `unaudited`, never `absent`, because coverage
   * cannot be verified against a category the report doesn't know.
   */
  category: TagCategory | null;
  present: TagCoverageBucket;
  absent: TagCoverageBucket;
  unaudited: TagCoverageBucket;
}

export interface TagCoverageReport {
  entries: TagCoverageEntry[];
}

/**
 * Raw, verdict-free counts behind the library-readiness signal (plan §10.D),
 * all scoped to ACTIVE books. Read by {@link CuratorDb.getReadinessCounts}.
 *
 * The `*Attempted` / `*Unknown` members exist solely so the caller can tell
 * "checked, and the answer was no" apart from "never checked" — invariant 5.
 * Drop one of them and the corresponding percentage silently starts reporting
 * a confident `0%` for work that never ran.
 */
export interface ReadinessCounts {
  /** Denominator for every metric: active (non-tombstoned) books. */
  totalBooks: number;
  /** Books with any `external_metadata` row, whatever its status — i.e. enrichment ran for them. */
  enrichmentAttempted: number;
  /** Books with an `external_metadata` row at status `'ok'`. */
  externalResolved: number;
  /** Books with at least one `book_entities` row. */
  withEntities: number;
  /** Books with a `tag_runs` row recorded at the requested schema version. */
  taggedAtVersion: number;
  /** Books carrying `book_tags` but no `tag_runs` row — tagged at an unrecorded schema version. */
  taggedVersionUnknown: number;
  /** Books with a `book_embeddings` row under the requested model. Always 0 when no model was given. */
  embeddedAtModel: number;
  /** Books with a `book_embeddings` row under any model. */
  embeddedAnyModel: number;
}

/** Lean cached-provider outcome used by the grounding residual census. Raw
 * payloads are deliberately excluded: the report needs status, not the
 * potentially large source document. */
export interface GroundingMetadataOutcome {
  bookId: string;
  provider: string;
  status: ExternalMetadataStatus;
}

/**
 * Persisted state of one librarian conversation (readiness item F, plan
 * §10.F/§5.3 — "session in SQLite", decided).
 *
 * `'running'` and `'interrupted'` are NOT `ConversationStatus` values
 * (`core/librarian/events.ts`), and that is the point. A conversation whose
 * `done` event was never recorded has no terminal status, and inventing one
 * is invariant 5: `'failed'` would claim an error nobody observed and
 * `'answered'` would claim an answer nobody produced. So:
 *
 * - `'running'` means literally "started, no terminal event recorded yet".
 *   Inside the process that owns the loop it is accurate and temporary.
 * - `'interrupted'` is what {@link CuratorDb.reconcileInterruptedConversations}
 *   rewrites it to at process start. That is a real observation, not a guess:
 *   the loop lives in-process, so no conversation can legitimately still be
 *   running when a process has only just opened the database. It says the run
 *   was cut off and its outcome is unknown — which is exactly the mid-run
 *   reboot §10.F was written about. Leaving such a row `'running'` forever
 *   would persist the §10.E bug: a feed that reads as "still thinking".
 */
export type PersistedConversationStatus = 'running' | 'interrupted' | ConversationStatus;

export interface PersistedConversation {
  id: string;
  /** Thread identity. Legacy rows are migrated to a one-turn thread whose id
   * equals the original conversation id. */
  threadId: string;
  /** Exact user input for this turn. Null only for pre-history legacy rows. */
  question: string | null;
  turnIndex: number;
  status: PersistedConversationStatus;
  startedAt: number;
  /** Last write of any kind — event appended, or status resolved. */
  updatedAt: number;
}

export interface ConversationListCursor {
  createdAt: number;
  id: string;
}

export interface ConversationDetailCursor {
  threadId: string;
  turnIndex: number;
  id: string;
  eventSeq: number;
}

export interface PersistedConversationThreadSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  latestStatus: PersistedConversationStatus;
  latestQuestion: string | null;
}

export interface PersistedConversationTurn extends PersistedConversation {
  events: PersistedConversationEvent[];
}

export interface PersistedConversationThread {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: PersistedConversationTurn[];
}

export interface PersistedConversationThreadPage extends PersistedConversationThread {
  nextCursor: ConversationDetailCursor | null;
}

/** One recorded event, with the per-conversation ordinal it was written at. */
export interface PersistedConversationEvent {
  /** 0-based, gapless, and assigned from the stored maximum, so it keeps
   *  counting correctly for a conversation resumed after a restart. */
  seq: number;
  event: LibrarianEvent;
  recordedAt: number;
}

/** A book plus its currently-stored embedding identity (null when never embedded). */
export interface EmbeddingCandidate {
  book: Book;
  /** Model of the stored embedding, or null when the book has never been embedded. */
  storedModel: string | null;
  /** card_hash of the stored embedding, or null when never embedded. */
  storedCardHash: string | null;
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  series TEXT,
  series_sequence REAL,
  duration_seconds INTEGER,
  published_year INTEGER,
  genres TEXT,
  description TEXT,
  cover_path TEXT,
  abs_added_at INTEGER,
  last_synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT, last_successful_sync_at INTEGER
);

CREATE TABLE IF NOT EXISTS book_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id),
  tag TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  tagged_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'llm-open',
  UNIQUE(book_id, tag)
);

CREATE TABLE IF NOT EXISTS tag_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id),
  categories TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  tagged_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  theme TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  abs_collection_id TEXT,
  created_at INTEGER NOT NULL,
  pushed_at INTEGER
);

CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS collection_books (
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  book_id TEXT NOT NULL REFERENCES books(id),
  sort_order INTEGER,
  PRIMARY KEY (collection_id, book_id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS encode_queue (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  sort_order INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS encode_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS encode_candidates (
  library_item_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  files_json TEXT NOT NULL,
  total_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_metadata (
  book_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  payload TEXT,
  fetched_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (book_id, provider)
);

CREATE TABLE IF NOT EXISTS book_entities (
  book_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  kind TEXT NOT NULL,
  sources TEXT NOT NULL,
  notable INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (book_id, entity, kind)
);

CREATE TABLE IF NOT EXISTS tag_aliases (
  alias TEXT NOT NULL,
  canonical TEXT NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (alias, category)
);

CREATE TABLE IF NOT EXISTS vocab_terms (
  term TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  -- Displayed/sorted count: MAX(tagger_book_count, enrichment_book_count).
  -- Neither signal alone is "the" count for a term both passes evidence —
  -- they measure different populations (llm-open book_tags usage vs. cached
  -- provider-subject evidence) — so this column is derived, not owned by
  -- whichever pass happens to write it first. See tagger_book_count /
  -- enrichment_book_count below and refreshProposedVocabCounts /
  -- refreshEnrichmentVocabProposals in db.ts.
  book_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  -- Which pass proposed a 'proposed' row: 'tagger' (llm-open book_tags) or
  -- 'enrichment' (R1's cached-subjects promotion) — decides which pass's
  -- prune step may DELETE the row outright when BOTH counts below hit zero.
  -- Meaningful only for status='proposed' — see core/types.ts#VocabTermOrigin.
  origin TEXT NOT NULL DEFAULT 'tagger',
  -- This term's book count from llm-open book_tags, refreshed by
  -- refreshProposedVocabCounts regardless of origin — a term this pass
  -- still evidences is never left stale just because origin='enrichment'.
  tagger_book_count INTEGER NOT NULL DEFAULT 0,
  -- This term's book count from cached provider subjects, refreshed by
  -- refreshEnrichmentVocabProposals regardless of origin — same reasoning.
  enrichment_book_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, category)
);

CREATE TABLE IF NOT EXISTS book_embeddings (
  book_id   TEXT PRIMARY KEY,
  model     TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  vector    BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS book_edges (
  from_book TEXT NOT NULL,
  to_book   TEXT NOT NULL,
  relation  TEXT NOT NULL,
  score     REAL,
  source    TEXT NOT NULL,
  PRIMARY KEY (from_book, to_book, relation)
);

CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
  question TEXT,
  turn_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_events (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

-- ── Migration E: feedback & personalization (plan §1.6, §6) ────────────────
-- All four tables are additive and independently deployable. None of them is
-- referenced by any Phase 0–4 read path, so an install that never runs a
-- feedback capture behaves exactly as it did before they existed.

CREATE TABLE IF NOT EXISTS rec_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT,
  external_key TEXT,
  query_text TEXT NOT NULL,
  verdict TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'explicit',
  weight REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rec_impressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slate_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  book_id TEXT,
  external_key TEXT,
  rank INTEGER NOT NULL,
  score REAL,
  shown_at INTEGER NOT NULL
);

-- Snapshot, overwritten per sync. Deliberately NOT a foreign key on books:
-- ABS can report progress for an item this mirror has not synced yet, and
-- losing that row to a constraint would silently drop the strongest signal
-- the system has.
CREATE TABLE IF NOT EXISTS listening_progress (
  book_id TEXT PRIMARY KEY,
  progress REAL NOT NULL,
  is_finished INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  time_listening INTEGER NOT NULL,
  last_played_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Append-only, keyed by the ABS session id so a re-sync is idempotent.
CREATE TABLE IF NOT EXISTS listening_sessions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  playback_speed REAL,
  device TEXT
);

CREATE INDEX IF NOT EXISTS idx_rec_feedback_book ON rec_feedback(book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_feedback_created ON rec_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_impressions_slate ON rec_impressions(slate_id, rank);
CREATE INDEX IF NOT EXISTS idx_rec_impressions_book ON rec_impressions(book_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_listening_sessions_book ON listening_sessions(book_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_listening_sessions_started ON listening_sessions(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_book_tags_book ON book_tags(book_id);
CREATE INDEX IF NOT EXISTS idx_book_tags_category ON book_tags(category);
CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag);
CREATE INDEX IF NOT EXISTS idx_tag_runs_book ON tag_runs(book_id);
CREATE INDEX IF NOT EXISTS idx_collection_books_collection ON collection_books(collection_id);
CREATE INDEX IF NOT EXISTS idx_books_series ON books(series);
CREATE INDEX IF NOT EXISTS idx_book_entities_book ON book_entities(book_id);
CREATE INDEX IF NOT EXISTS idx_external_metadata_status ON external_metadata(provider, status, fetched_at);
CREATE INDEX IF NOT EXISTS idx_book_embeddings_model ON book_embeddings(model);
CREATE INDEX IF NOT EXISTS idx_book_edges_from ON book_edges(from_book, relation);
CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated ON conversation_threads(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_threads_created ON conversation_threads(created_at DESC, id DESC);
`;

/**
 * Fields compared to classify an upsert as added / updated / unchanged.
 *
 * `narrator` is deliberately NOT compared the way `genres`/`description` are.
 * Unlike those ABS-only fields, `narrator` has a second legitimate writer
 * (`CuratorDb#setNarrator`, the R3 cache-only Audnexus pass), and `upsertBook`
 * only ever touches the column when ABS itself reports a name (see the
 * `COALESCE` in `upsertBook`'s UPDATE below) — a sync with no `narratorName`
 * leaves the stored value exactly as it was, whoever wrote it. So from this
 * comparison's point of view, an incoming sync with no narrator can never by
 * itself make the row "updated": either ABS supplies a name and it is
 * compared against what's stored, or it doesn't and the column is a no-op,
 * which must compare equal to itself.
 */
function bookContentEqual(existing: BookRow, next: Book): boolean {
  const incomingNarrator = next.narrator && next.narrator.length > 0 ? JSON.stringify(next.narrator) : null;
  return (
    existing.title === next.title &&
    existing.author === next.author &&
    existing.series === next.series &&
    existing.series_sequence === next.seriesSequence &&
    existing.duration_seconds === next.durationSeconds &&
    existing.published_year === next.publishedYear &&
    existing.genres === JSON.stringify(next.genres) &&
    existing.description === next.description &&
    existing.cover_path === next.coverPath &&
    existing.abs_added_at === next.absAddedAt &&
    existing.narrator === (incomingNarrator ?? existing.narrator)
  );
}

export type UpsertOutcome = 'added' | 'updated' | 'unchanged';

/**
 * Typed wrapper around the SQLite connection. Construct once and share the single
 * instance across sync / tagger / collectionEngine (and api + mcp).
 */
export class CuratorDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    try {
      if (dbPath !== ':memory:') {
        const dir = dirname(dbPath);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      // Retry briefly on SQLITE_BUSY instead of failing immediately (Task 6.1) —
      // matters when DB_PATH is on a network volume.
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(MIGRATIONS);
      this.applyMigrations();
      this.seedVocabulary();
    } catch (err) {
      throw new DBError(`Failed to open database at ${dbPath}`, err);
    }
  }

  /**
   * Idempotently insert every {@link SEED_VOCABULARY} term as a `status='seed'`
   * row. Runs on every startup (INSERT OR IGNORE) — never overwrites a row
   * that already exists, so a term promoted/rejected by the user stays that
   * way even though it's still present in the hardcoded seed list.
   */
  private seedVocabulary(): void {
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO vocab_terms (term, category, status, book_count, first_seen)
       VALUES (?, ?, 'seed', 0, ?)`
    );
    const txn = this.db.transaction(() => {
      for (const [category, terms] of Object.entries(SEED_VOCABULARY) as Array<[TagCategory, readonly string[]]>) {
        for (const term of terms) insert.run(term, category, now);
      }
    });
    txn();
  }

  private applyMigrations(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(books)').all() as Array<{name:string}>).map(c => c.name));
    const additions: Array<[string,string]> = [
      ['library_id','TEXT'], ['item_path','TEXT'], ['asin','TEXT'], ['isbn','TEXT'],
      ['abs_updated_at','INTEGER'], ['last_seen_sync_id','TEXT'],
      ['sync_status',"TEXT NOT NULL DEFAULT 'active'"], ['deleted_at','INTEGER'],
      ['normalized_title','TEXT'], ['title_parse','TEXT'], ['title_meta_source','TEXT'],
      // R2 (description backfill): harvested text + its provider, written only
      // by the cache-only backfill pass — `books.description` stays the ABS
      // mirror untouched. R3 (narrator): JSON-encoded list, mirroring `genres`.
      ['description_enriched','TEXT'], ['description_source','TEXT'], ['narrator','TEXT']
    ];
    const migrate = this.db.transaction(() => {
      for (const [name, sql] of additions) if (!columns.has(name)) this.db.exec(`ALTER TABLE books ADD COLUMN ${name} ${sql}`);
      const collectionColumns = new Set((this.db.prepare('PRAGMA table_info(collections)').all() as Array<{name:string}>).map(c => c.name));
      if (!collectionColumns.has('library_id')) this.db.exec('ALTER TABLE collections ADD COLUMN library_id TEXT');
      if (!collectionColumns.has('ownership_marker')) this.db.exec('ALTER TABLE collections ADD COLUMN ownership_marker TEXT');
      const bookTagColumns = new Set((this.db.prepare('PRAGMA table_info(book_tags)').all() as Array<{name:string}>).map(c => c.name));
      if (!bookTagColumns.has('source')) this.db.exec("ALTER TABLE book_tags ADD COLUMN source TEXT NOT NULL DEFAULT 'llm-open'");
      // Default 1 so every existing row keeps behaving exactly as it did
      // before this column existed (full card text, full validation
      // allowlist) until the next enrichment run recomputes it — see
      // enrichment/entityNotability.ts.
      const bookEntityColumns = new Set((this.db.prepare('PRAGMA table_info(book_entities)').all() as Array<{name:string}>).map(c => c.name));
      if (!bookEntityColumns.has('notable')) this.db.exec('ALTER TABLE book_entities ADD COLUMN notable INTEGER NOT NULL DEFAULT 1');
      // R1 (subjects -> canonicalizer): distinguishes an llm-open 'proposed'
      // row (origin='tagger', from refreshProposedVocabCounts) from a cached
      // provider-subjects one (origin='enrichment', from
      // refreshEnrichmentVocabProposals) so neither pass's DELETE/UPDATE can
      // ever touch the other's rows. Default keeps every pre-existing row
      // behaving exactly as it did before this column existed.
      const vocabTermColumns = new Set((this.db.prepare('PRAGMA table_info(vocab_terms)').all() as Array<{name:string}>).map(c => c.name));
      if (!vocabTermColumns.has('origin')) this.db.exec("ALTER TABLE vocab_terms ADD COLUMN origin TEXT NOT NULL DEFAULT 'tagger'");
      // R1 follow-up: `book_count` cannot represent two populations at once
      // without one pass's refresh permanently freezing the other's number
      // for any (term, category) both want (see the CREATE TABLE comment
      // above). Backfill from the pre-existing `book_count`/`origin` pair so
      // an upgraded install's counts start correct rather than at zero.
      if (!vocabTermColumns.has('tagger_book_count')) {
        this.db.exec('ALTER TABLE vocab_terms ADD COLUMN tagger_book_count INTEGER NOT NULL DEFAULT 0');
        this.db.exec("UPDATE vocab_terms SET tagger_book_count = book_count WHERE origin = 'tagger'");
      }
      if (!vocabTermColumns.has('enrichment_book_count')) {
        this.db.exec('ALTER TABLE vocab_terms ADD COLUMN enrichment_book_count INTEGER NOT NULL DEFAULT 0');
        this.db.exec("UPDATE vocab_terms SET enrichment_book_count = book_count WHERE origin = 'enrichment'");
      }
      const conversationColumns = new Set((this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{name:string}>).map(c => c.name));
      if (!conversationColumns.has('thread_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN thread_id TEXT');
      if (!conversationColumns.has('question')) this.db.exec('ALTER TABLE conversations ADD COLUMN question TEXT');
      if (!conversationColumns.has('turn_index')) this.db.exec('ALTER TABLE conversations ADD COLUMN turn_index INTEGER');
      // Compatibility migration: every old run becomes a one-turn thread.
      // The question remains NULL because older storage never recorded it;
      // fabricating one from public events would be dishonest.
      this.db.exec(`
        INSERT OR IGNORE INTO conversation_threads (id, created_at, updated_at)
        SELECT id, started_at, updated_at FROM conversations WHERE thread_id IS NULL;
        UPDATE conversations SET thread_id = id WHERE thread_id IS NULL;
        UPDATE conversations SET turn_index = 0 WHERE turn_index IS NULL;
      `);
      const conversationForeignKeys = this.db.prepare('PRAGMA foreign_key_list(conversations)').all() as Array<{
        table: string;
        from: string;
      }>;
      if (!conversationForeignKeys.some((key) => key.table === 'conversation_threads' && key.from === 'thread_id')) {
        // SQLite cannot add a foreign key with ALTER TABLE. Rebuild both the
        // parent and child tables together so conversation_events keeps its
        // own FK and no row is ever copied outside this transaction.
        this.db.exec(`
          CREATE TABLE conversations_rebuilt (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
            question TEXT,
            turn_index INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE conversation_events_rebuilt (
            conversation_id TEXT NOT NULL REFERENCES conversations_rebuilt(id),
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            PRIMARY KEY (conversation_id, seq)
          );
          INSERT INTO conversations_rebuilt
            SELECT id, thread_id, question, turn_index, status, started_at, updated_at FROM conversations;
          INSERT INTO conversation_events_rebuilt
            SELECT conversation_id, seq, type, payload, recorded_at FROM conversation_events;
          DROP TABLE conversation_events;
          DROP TABLE conversations;
          ALTER TABLE conversations_rebuilt RENAME TO conversations;
          ALTER TABLE conversation_events_rebuilt RENAME TO conversation_events;
        `);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_thread_turn
          ON conversations(thread_id, turn_index);
        CREATE INDEX IF NOT EXISTS idx_conversations_thread
          ON conversations(thread_id, turn_index);
        CREATE INDEX IF NOT EXISTS idx_conversation_threads_created
          ON conversation_threads(created_at DESC, id DESC);
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(Date.now());
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_books_library_active ON books(library_id, sync_status)');
    });
    migrate();
  }

  /**
   * Write a consistent single-file copy of the database to `destPath`.
   *
   * `VACUUM INTO` rather than a file copy, for two reasons that both matter
   * on a running instance: it folds the WAL into the output (a plain `cp` of
   * `curator.db` silently omits everything still sitting in `curator.db-wal`,
   * which here is megabytes), and it takes a read lock rather than blocking
   * writers for the duration. The source database is not modified.
   *
   * SQLite refuses to overwrite, so `destPath` must not already exist — the
   * caller owns picking a unique path and cleaning it up.
   */
  vacuumInto(destPath: string): void {
    try {
      // `VACUUM INTO` takes a string literal, not a bound parameter, so the
      // path is quoted by doubling single quotes. Callers pass server-derived
      // paths, never user input, but the escape keeps that true by construction.
      const quoted = destPath.replace(/'/g, "''");
      this.db.exec(`VACUUM INTO '${quoted}'`);
    } catch (err) {
      throw new DBError(`Failed to write database snapshot to ${destPath}`, err);
    }
  }

  /** Expose the raw handle for health checks only. */
  isWritable(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  // ── books ──────────────────────────────────────────────────────────────────

  getBook(id: string): Book | undefined {
    const row = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined;
    return row ? mapBook(row) : undefined;
  }

  upsertBook(book: Book): UpsertOutcome {
    try {
      const existing = this.db.prepare('SELECT * FROM books WHERE id = ?').get(book.id) as
        | BookRow
        | undefined;
      const genresJson = JSON.stringify(book.genres);
      // Mirrors `genres`: an absent/empty narrator list is stored as NULL,
      // not '[]', so "no narrator known" round-trips back to `null` (see
      // mapBook) rather than an empty array.
      const narratorJson = book.narrator && book.narrator.length > 0 ? JSON.stringify(book.narrator) : null;
      const params = { ...book, genres: genresJson, narrator: narratorJson, libraryId: book.libraryId ?? null,
        itemPath: book.itemPath ?? null, asin: book.asin ?? null, isbn: book.isbn ?? null,
        absUpdatedAt: book.absUpdatedAt ?? null, lastSeenSyncId: book.lastSeenSyncId ?? null };

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO books
               (id, title, author, series, series_sequence, duration_seconds,
                published_year, genres, description, cover_path, abs_added_at, last_synced_at,
                library_id, item_path, asin, isbn, abs_updated_at, last_seen_sync_id, sync_status, deleted_at,
                narrator)
             VALUES (@id, @title, @author, @series, @seriesSequence, @durationSeconds,
                @publishedYear, @genres, @description, @coverPath, @absAddedAt, @lastSyncedAt,
                @libraryId, @itemPath, @asin, @isbn, @absUpdatedAt, @lastSeenSyncId, 'active', NULL,
                @narrator)`
          )
          .run(params);
        return 'added';
      }

      const unchanged = bookContentEqual(existing, book);
      // Always refresh last_synced_at so "last seen" is accurate even if unchanged.
      // description_enriched / description_source are deliberately absent from
      // this SET list — they are written only by CuratorDb#setEnrichedDescription,
      // never by a sync, so an ABS re-sync can never clobber harvested text.
      //
      // narrator=COALESCE(@narrator, narrator): unlike description, narrator
      // has two legitimate writers sharing one column (ABS's narratorName via
      // this method, and Audnexus via setNarrator), and "whichever writes
      // last wins" is the intended contract — but a sync where ABS reports NO
      // narratorName is not really "ABS writing null", it is ABS having
      // nothing to say. Without the COALESCE, that non-write would still hit
      // the column as a literal NULL on every subsequent sync and permanently
      // erase anything setNarrator had written. @narrator is NULL exactly
      // when `book.narrator` is empty/absent (see narratorJson above), so
      // COALESCE falls back to the existing stored value in precisely that
      // case and only overwrites when ABS actually supplied a name.
      this.db
        .prepare(
          `UPDATE books SET
             title=@title, author=@author, series=@series, series_sequence=@seriesSequence,
             duration_seconds=@durationSeconds, published_year=@publishedYear, genres=@genres,
             description=@description, cover_path=@coverPath, abs_added_at=@absAddedAt,
             last_synced_at=@lastSyncedAt, library_id=@libraryId, item_path=@itemPath,
             asin=@asin, isbn=@isbn, abs_updated_at=@absUpdatedAt,
             last_seen_sync_id=@lastSeenSyncId, sync_status='active', deleted_at=NULL,
             narrator=COALESCE(@narrator, narrator)
           WHERE id=@id`
        )
        .run(params);
      return unchanged ? 'unchanged' : 'updated';
    } catch (err) {
      throw new DBError(`Failed to upsert book ${book.id}`, err);
    }
  }

  /**
   * Persist (or clear) the harvested description for one book, independent
   * of `upsertBook`. `description_enriched` and `description_source` are
   * always written or cleared TOGETHER — passing an object writes both,
   * passing `null` clears both — so the pair can never disagree about
   * whether a harvested description exists.
   *
   * This never touches `books.description` (the ABS mirror). Effective
   * description resolution (ABS-if-present, else this) is
   * `core/enrichment/descriptionText.ts#resolveDescription`'s job, not this
   * method's — this is a pure setter.
   */
  setEnrichedDescription(bookId: string, enriched: { text: string; source: DescriptionSource } | null): void {
    try {
      this.db
        .prepare('UPDATE books SET description_enriched = ?, description_source = ? WHERE id = ?')
        .run(enriched?.text ?? null, enriched?.source ?? null, bookId);
    } catch (err) {
      throw new DBError(`Failed to set enriched description for book ${bookId}`, err);
    }
  }

  /**
   * Persist (or clear) the narrator list for one book, independent of a full
   * `upsertBook` call. `upsertBook` writes `narrator` from ABS's
   * `narratorName` on every sync (JSON-encoded exactly like `genres`) BUT
   * only when ABS actually reports a name — see the `COALESCE` in
   * `upsertBook`'s UPDATE. This setter exists so a cache-only enrichment pass
   * (e.g. Audnexus `narrators[]`) can update the same column without going
   * through a whole book upsert. There is no separate provenance column —
   * `genres` itself has none either — so whichever caller writes last wins;
   * an empty or absent list is stored as NULL, matching `upsertBook`'s own
   * encoding. Critically, "last wins" means last *actual* write: a sync that
   * finds no `narratorName` is not a write at all and will never undo what
   * this method stored, so a value set here survives indefinitely until
   * either ABS starts reporting its own narrator or this method is called
   * again (including with `null`, to explicitly clear it).
   */
  setNarrator(bookId: string, narrator: string[] | null): void {
    try {
      const narratorJson = narrator && narrator.length > 0 ? JSON.stringify(narrator) : null;
      this.db.prepare('UPDATE books SET narrator = ? WHERE id = ?').run(narratorJson, bookId);
    } catch (err) {
      throw new DBError(`Failed to set narrator for book ${bookId}`, err);
    }
  }

  upsertLibrary(library: { id: string; name: string; mediaType?: string }, syncedAt?: number): void {
    this.db.prepare(`INSERT INTO libraries(id,name,media_type,last_successful_sync_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,media_type=excluded.media_type,
      last_successful_sync_at=COALESCE(excluded.last_successful_sync_at,libraries.last_successful_sync_at)`)
      .run(library.id, library.name, library.mediaType ?? null, syncedAt ?? null);
  }

  tombstoneUnseen(libraryId: string, syncId: string, now: number): number {
    return this.db.prepare(`UPDATE books SET sync_status='deleted', deleted_at=?
      WHERE library_id=? AND sync_status='active' AND COALESCE(last_seen_sync_id,'')<>?`).run(now, libraryId, syncId).changes;
  }

  tombstoneBook(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE books SET sync_status='deleted', deleted_at=? WHERE id=?").run(now, id);
  }

  claimWebhookEvent(id:string,now=Date.now()):boolean { return this.db.prepare('INSERT OR IGNORE INTO webhook_events(id,received_at) VALUES(?,?)').run(id,now).changes===1; }

  countBooks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM books').get() as { c: number };
    return row.c;
  }

  /** Active (non-tombstoned) book count — the `librarySize` scale factor for
   *  {@link scoreNotability}'s frequency penalty. */
  countActiveBooks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM books WHERE sync_status='active'").get() as { c: number };
    return row.c;
  }

  getUntaggedBooks(bookIds?: string[]): Book[] {
    try {
      if (bookIds && bookIds.length > 0) {
        const placeholders = bookIds.map(() => '?').join(',');
        const rows = this.db
          .prepare(
            `SELECT * FROM books WHERE id IN (${placeholders})
               AND id NOT IN (SELECT DISTINCT book_id FROM book_tags)
             ORDER BY title`
          )
          .all(...bookIds) as BookRow[];
        return rows.map(mapBook);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM books
             WHERE id NOT IN (SELECT DISTINCT book_id FROM book_tags)
           ORDER BY title`
        )
        .all() as BookRow[];
      return rows.map(mapBook);
    } catch (err) {
      throw new DBError('Failed to query untagged books', err);
    }
  }

  /** Active books, optionally restricted to `bookIds` (same shape as {@link getEnrichmentCandidates}'s scoping). */
  getAllBooks(bookIds?: string[]): Book[] {
    if (bookIds && bookIds.length > 0) {
      const placeholders = bookIds.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM books WHERE sync_status='active' AND id IN (${placeholders}) ORDER BY title`)
        .all(...bookIds) as BookRow[];
      return rows.map(mapBook);
    }
    const rows = this.db.prepare("SELECT * FROM books WHERE sync_status='active' ORDER BY title").all() as BookRow[];
    return rows.map(mapBook);
  }

  /** Active books with no grounded entity rows. Used by the read-only
   * grounding residual report; deliberately bulk-loaded to avoid an entity
   * lookup per book on large libraries. */
  getUngroundedBooks(): Book[] {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM books b
         WHERE b.sync_status='active'
           AND NOT EXISTS (
             SELECT 1 FROM book_entities be
             WHERE be.book_id = b.id AND be.kind IN ('person','place')
           )
         ORDER BY b.title`
      )
      .all() as BookRow[];
    return rows.map(mapBook);
  }

  /** Cached provider outcomes for active books that still have no grounded
   * entities. Paired with {@link getUngroundedBooks} so the residual report
   * needs two bounded reads rather than N per-book queries. */
  getExternalMetadataOutcomesForUngroundedBooks(): GroundingMetadataOutcome[] {
    const rows = this.db
      .prepare(
        `SELECT em.book_id AS bookId, em.provider, em.status FROM external_metadata em
         JOIN books b ON b.id = em.book_id AND b.sync_status='active'
         WHERE NOT EXISTS (
           SELECT 1 FROM book_entities be
           WHERE be.book_id = b.id AND be.kind IN ('person','place')
         )
         ORDER BY em.book_id, em.provider`
      )
      .all() as GroundingMetadataOutcome[];
    return rows;
  }

  getAllBookTags(): BookTag[] {
    const rows = this.db.prepare('SELECT * FROM book_tags').all() as BookTagRow[];
    return rows.map(mapBookTag);
  }

  /** Distinct book ids that carry any of `tags` in `category` at/above confidence. */
  getBookIdsByTag(category: TagCategory, tags: string[], minConfidence = 0): string[] {
    if (tags.length === 0) return [];
    const placeholders = tags.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT book_id FROM book_tags
         WHERE category = ? AND tag IN (${placeholders}) AND confidence >= ?`
      )
      .all(category, ...tags, minConfidence) as { book_id: string }[];
    return rows.map((r) => r.book_id);
  }

  getSeriesStarters(): Book[] {
    const rows = this.db
      .prepare('SELECT * FROM books WHERE series IS NOT NULL AND series_sequence = 1 ORDER BY title')
      .all() as BookRow[];
    return rows.map(mapBook);
  }

  getStandalones(): Book[] {
    const rows = this.db
      .prepare('SELECT * FROM books WHERE series IS NULL ORDER BY title')
      .all() as BookRow[];
    return rows.map(mapBook);
  }

  getBooksByIds(bookIds: string[]): Book[] {
    if (bookIds.length === 0) return [];
    const placeholders = bookIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM books WHERE id IN (${placeholders})`)
      .all(...bookIds) as BookRow[];
    return rows.map(mapBook);
  }

  /** Return the subset of the given ids that exist in `books`. */
  existingBookIds(bookIds: string[]): Set<string> {
    if (bookIds.length === 0) return new Set();
    const placeholders = bookIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id FROM books WHERE id IN (${placeholders})`)
      .all(...bookIds) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Build one `book_tags` predicate fragment (`bt.tag = ? [AND bt.category = ?]
   * [AND bt.confidence >= ?] [AND bt.source != 'llm-open']`), pushing its
   * placeholder values onto `params` in the same order they appear in the
   * fragment. Meant to be embedded inside an `EXISTS`/`NOT EXISTS` subquery
   * that already binds `bt.book_id = b.id`.
   */
  private tagPredicate(f: TagFilter, params: unknown[], trustedOnly: boolean): string {
    const parts: string[] = ['bt.tag = ?'];
    params.push(f.tag);
    if (f.category) {
      parts.push('bt.category = ?');
      params.push(f.category);
    }
    if (f.minConfidence !== undefined) {
      parts.push('bt.confidence >= ?');
      params.push(f.minConfidence);
    }
    if (trustedOnly) {
      parts.push("bt.source != 'llm-open'");
    }
    return parts.join(' AND ');
  }

  /**
   * Build one `book_entities` predicate fragment. Entity matching is
   * case-insensitive (`COLLATE NOCASE`); `kind` when present is exact. Meant
   * to be embedded inside an `EXISTS` subquery that already binds
   * `be.book_id = b.id`.
   *
   * SQLite's built-in `NOCASE` collation only folds ASCII `A-Z`/`a-z` — it does
   * NOT case-fold accented or non-Latin characters (e.g. "Zoë" vs "ZOË" will
   * NOT match). Grounded entities come from external providers and routinely
   * carry accented names, so this is a partial case-insensitivity guarantee,
   * not a full Unicode one.
   */
  private entityPredicate(f: EntityFilter, params: unknown[]): string {
    const parts: string[] = ['be.entity = ? COLLATE NOCASE'];
    params.push(f.entity);
    if (f.kind) {
      parts.push('be.kind = ?');
      params.push(f.kind);
    }
    return parts.join(' AND ');
  }

  /**
   * `allTags`/`anyTags`/`excludeTags`/`allEntities`/`anyEntities` are hard SQL
   * predicates (EXISTS/NOT EXISTS subqueries) — never vector arithmetic and
   * never a score penalty. `excludeTags` in particular always removes a
   * matching book outright rather than down-ranking it.
   *
   * `trustedOnly` (default false, preserving today's SQL byte-for-byte when
   * absent) narrows every tag predicate in the query — including the
   * pre-existing `tag`/`category`/`minConfidence` filter — to
   * `book_tags.source != 'llm-open'`.
   *
   * Every empty filter array contributes no predicate at all.
   */
  queryBooks(filters: BookQueryFilters): BookQueryResult {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const where: string[] = ["b.sync_status='active'"];
    // INVARIANT: `where` and `params` are built in lockstep, fragment by fragment.
    // Every `?` placeholder pushed into `where` must have its bound value pushed
    // onto `params` at the same point, in the same order — `params` is reused
    // verbatim for both the COUNT(*) query and the row query below, so any drift
    // between the two silently desyncs `total` from the actual returned rows.
    const params: unknown[] = [];
    if(filters.libraryId){where.push('b.library_id=?');params.push(filters.libraryId);}

    if (filters.search) {
      where.push('(b.title LIKE ? OR b.author LIKE ?)');
      const like = `%${filters.search}%`;
      params.push(like, like);
    }
    if (filters.author) {
      where.push('b.author LIKE ?');
      params.push(`%${filters.author}%`);
    }
    if (filters.untagged) {
      where.push('b.id NOT IN (SELECT DISTINCT book_id FROM book_tags)');
    }
    const trustedOnly = filters.trustedOnly ?? false;
    if (filters.tag || filters.category || filters.minConfidence !== undefined) {
      const tagWhere: string[] = ['bt.book_id = b.id'];
      if (filters.tag) {
        tagWhere.push('bt.tag = ?');
        params.push(filters.tag);
      }
      if (filters.category) {
        tagWhere.push('bt.category = ?');
        params.push(filters.category);
      }
      if (filters.minConfidence !== undefined) {
        tagWhere.push('bt.confidence >= ?');
        params.push(filters.minConfidence);
      }
      if (trustedOnly) {
        tagWhere.push("bt.source != 'llm-open'");
      }
      where.push(`EXISTS (SELECT 1 FROM book_tags bt WHERE ${tagWhere.join(' AND ')})`);
    }

    if (filters.allTags && filters.allTags.length > 0) {
      for (const f of filters.allTags) {
        const predicate = this.tagPredicate(f, params, trustedOnly);
        where.push(`EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND ${predicate})`);
      }
    }

    if (filters.anyTags && filters.anyTags.length > 0) {
      const predicates = filters.anyTags.map((f) => `(${this.tagPredicate(f, params, trustedOnly)})`);
      where.push(`EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND (${predicates.join(' OR ')}))`);
    }

    if (filters.excludeTags && filters.excludeTags.length > 0) {
      // `false`, never `trustedOnly` — an exclusion considers every tag
      // regardless of provenance. See the BookQueryFilters.trustedOnly
      // docblock: unverified evidence is enough to drop a book, never enough
      // to pardon one. This asymmetry is intentional; do not "fix" it.
      const predicates = filters.excludeTags.map((f) => `(${this.tagPredicate(f, params, false)})`);
      where.push(
        `NOT EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND (${predicates.join(' OR ')}))`
      );
    }

    if (filters.allEntities && filters.allEntities.length > 0) {
      for (const f of filters.allEntities) {
        const predicate = this.entityPredicate(f, params);
        where.push(`EXISTS (SELECT 1 FROM book_entities be WHERE be.book_id = b.id AND ${predicate})`);
      }
    }

    if (filters.anyEntities && filters.anyEntities.length > 0) {
      const predicates = filters.anyEntities.map((f) => `(${this.entityPredicate(f, params)})`);
      where.push(
        `EXISTS (SELECT 1 FROM book_entities be WHERE be.book_id = b.id AND (${predicates.join(' OR ')}))`
      );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM books b ${whereSql}`)
      .get(...params) as { c: number };

    const rows = this.db
      .prepare(`SELECT b.* FROM books b ${whereSql} ORDER BY b.title LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as BookRow[];

    return { books: rows.map(mapBook), total: totalRow.c, limit, offset };
  }

  // ── book_tags ────────────────────────────────────────────────────────────

  getTagsForBook(bookId: string): BookTag[] {
    const rows = this.db
      .prepare('SELECT * FROM book_tags WHERE book_id = ? ORDER BY category, confidence DESC')
      .all(bookId) as BookTagRow[];
    return rows.map(mapBookTag);
  }

  /**
   * Replace ALL tags for a book in a single transaction (idempotent — case C2:
   * re-tag replaces, never appends). FK integrity (C3) is enforced by the insert
   * referencing books(id) with foreign_keys=ON.
   */
  replaceBookTags(bookId: string, tags: Array<GeneratedTag & { source: TagSource }>, taggedAt: number): void {
    try {
      const txn = this.db.transaction((items: Array<GeneratedTag & { source: TagSource }>) => {
        this.db.prepare('DELETE FROM book_tags WHERE book_id = ?').run(bookId);
        const insert = this.db.prepare(
          `INSERT INTO book_tags (book_id, tag, category, confidence, tagged_at, source)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(book_id, tag) DO UPDATE SET
             category = excluded.category,
             confidence = excluded.confidence,
             tagged_at = excluded.tagged_at,
             source = excluded.source`
        );
        for (const t of items) {
          insert.run(bookId, t.tag, t.category, t.confidence, taggedAt, t.source);
        }
      });
      txn(tags);
    } catch (err) {
      throw new DBError(`Failed to replace tags for book ${bookId}`, err);
    }
  }

  /**
   * Wipe every tag for a book, and with them the book's `tag_runs` history.
   *
   * Dropping the run history is the point, not a side effect. The rest of the
   * system defines "untagged" as "has no `book_tags` rows"
   * ({@link CuratorDb.getUntaggedBooks}), so a book whose tags were wiped is
   * one the tagger will pick up again from scratch. Leaving its old runs on
   * record would let {@link CuratorDb.getTagCoverage} answer `absent` —
   * "we checked, and it doesn't carry this" — from an audit whose every
   * conclusion has been erased.
   *
   * This is the write side of that rule, and it has to be the write side:
   * here we KNOW evidence was deleted. The read side cannot tell a book whose
   * tags were wiped from one that was audited and legitimately produced none,
   * and guessing there is what re-created invariant 6's produced-vs-attempted
   * conflation in mirror image (§10.A follow-up 1).
   *
   * `retainRuns` is for the one caller that is not retracting evidence: the
   * pre-clear inside a retag, which wipes tags only so that a mid-run failure
   * bounds its blast radius to one book. On the happy path a fresh
   * `recordTagRun` follows immediately, and dropping history there would make
   * `tag_runs` a single row per book — defeating the reason it is a table
   * rather than a column on `books`. The retag's FAILURE path calls this again
   * without the flag, which is where the retraction actually belongs.
   */
  deleteBookTags(bookId: string, options?: { retainRuns?: boolean }): number {
    try {
      const txn = this.db.transaction((id: string) => {
        const info = this.db.prepare('DELETE FROM book_tags WHERE book_id = ?').run(id);
        if (!options?.retainRuns) this.db.prepare('DELETE FROM tag_runs WHERE book_id = ?').run(id);
        return info.changes;
      });
      return txn(bookId) as number;
    } catch (err) {
      throw new DBError(`Failed to delete tags for book ${bookId}`, err);
    }
  }

  /**
   * Remove one (tag, category) pair from EVERY book — the transpose of
   * {@link CuratorDb.deleteBookTags}.
   *
   * Rejecting a vocab term only marks it non-promotable; the rows survive as
   * `llm-open`. That is not enough for a term that is simply wrong, because
   * `excludeTags` deliberately ignores `trustedOnly` (see the exclusion-safety
   * invariant): an unverified tag is weak grounds *for* a book but sufficient
   * grounds *against* one, so a bad tag does more damage in an exclusion than
   * a good one does in a match. This is the only way to actually retract it.
   *
   * Run-history invalidation is narrower here than in
   * {@link CuratorDb.deleteBookTags}, and deliberately so. Retracting one term
   * corrects an audit; it does not unmake it, and a book that still carries
   * other tags still has standing evidence that its categories were checked
   * (invariant 6: a run records what was ATTEMPTED, never what was produced).
   * Only a book this call leaves with **zero** tags crosses the same line
   * `deleteBookTags` crosses — it is now "untagged" by the rest of the
   * system's own definition — so only those books lose their `tag_runs`.
   * Invalidating per-category on every purge was considered and rejected: it
   * would mass-downgrade a whole library's coverage to `unaudited` on a single
   * bad-term purge, which is a different behaviour change than the one §10.A
   * asked for.
   */
  deleteTagTerm(tag: string, category: TagCategory): number {
    try {
      const txn = this.db.transaction((t: string, c: TagCategory) => {
        const affected = this.db
          .prepare('SELECT DISTINCT book_id FROM book_tags WHERE tag = ? AND category = ?')
          .all(t, c) as Array<{ book_id: string }>;
        const info = this.db.prepare('DELETE FROM book_tags WHERE tag = ? AND category = ?').run(t, c);

        const remaining = this.db.prepare('SELECT 1 FROM book_tags WHERE book_id = ? LIMIT 1');
        const clearRuns = this.db.prepare('DELETE FROM tag_runs WHERE book_id = ?');
        for (const { book_id: bookId } of affected) {
          if (!remaining.get(bookId)) clearRuns.run(bookId);
        }
        return info.changes;
      });
      return txn(tag, category) as number;
    } catch (err) {
      throw new DBError(`Failed to delete tag term ${category}:${tag}`, err);
    }
  }

  // ── tag_runs (librarian engine plan §10.A — three-state tag coverage) ──────

  /**
   * Record that a tagging run attempted `categories` for `bookId`, at
   * `schemaVersion`. Called from `tagger.ts` at the same point as
   * {@link CuratorDb.replaceBookTags} — it records what the run TRIED, not
   * what it produced, which is what lets {@link CuratorDb.getTagCoverage}
   * say "absent" instead of "unaudited" for a category the run attempted and
   * found nothing for. Never backfilled for pre-existing rows: a run we
   * didn't observe is a run we cannot honestly describe.
   */
  recordTagRun(bookId: string, categories: readonly TagCategory[], schemaVersion: number, taggedAt: number): void {
    try {
      this.db
        .prepare(`INSERT INTO tag_runs (book_id, categories, schema_version, tagged_at) VALUES (?, ?, ?, ?)`)
        .run(bookId, JSON.stringify(categories), schemaVersion, taggedAt);
    } catch (err) {
      throw new DBError(`Failed to record tag run for book ${bookId}`, err);
    }
  }

  /** Every recorded run for a book, newest first. Empty for a book that has
   *  never been tagged, or was tagged before `tag_runs` existed. */
  getTagRunsForBook(bookId: string): TagRun[] {
    const rows = this.db
      .prepare('SELECT * FROM tag_runs WHERE book_id = ? ORDER BY tagged_at DESC, id DESC')
      .all(bookId) as TagRunRow[];
    return rows.map(mapTagRun);
  }

  // ── conversations (librarian engine plan §10.F — conversation persistence) ──

  /**
   * Open a conversation record at status `'running'`. Called once, before the
   * round loop starts; every event the run emits is then appended against
   * this id by {@link CuratorDb.appendConversationEvent}.
   *
   * IDs are immutable. A duplicate fails atomically so a new sink can never
   * append onto a prior run or leave a zero-turn thread behind.
   */
  createConversation(id: string, startedAt: number): void {
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO conversation_threads (id, created_at, updated_at) VALUES (?, ?, ?)')
          .run(id, startedAt, startedAt);
        this.db.prepare(
          `INSERT INTO conversations
           (id, thread_id, question, turn_index, status, started_at, updated_at)
           VALUES (?, ?, NULL, 0, 'running', ?, ?)`
        ).run(id, id, startedAt, startedAt);
      })();
    } catch (err) {
      throw new DBError(`Failed to create conversation ${id}`, err);
    }
  }

  /** Open one immutable user turn. Existing thread ids must already exist;
   * callers cannot accidentally create a different thread under a typo. */
  createConversationTurn(id: string, threadId: string, question: string | null, startedAt: number): void {
    try {
      this.db.transaction(() => {
        const thread = this.db.prepare('SELECT id FROM conversation_threads WHERE id = ?').get(threadId);
        if (!thread) {
          if (id !== threadId) throw new Error(`Unknown conversation thread ${threadId}`);
          this.db.prepare('INSERT INTO conversation_threads (id, created_at, updated_at) VALUES (?, ?, ?)')
            .run(threadId, startedAt, startedAt);
        }
        const next = this.db.prepare(
          'SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM conversations WHERE thread_id = ?'
        ).get(threadId) as { next: number };
        this.db.prepare(
          `INSERT INTO conversations
           (id, thread_id, question, turn_index, status, started_at, updated_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`
        ).run(id, threadId, question, next.next, startedAt, startedAt);
        this.db.prepare('UPDATE conversation_threads SET updated_at = ? WHERE id = ?').run(startedAt, threadId);
      })();
    } catch (err) {
      throw new DBError(`Failed to create conversation turn ${id}`, err);
    }
  }

  hasConversationThread(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM conversation_threads WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Append one event to a conversation's recorded feed, returning the ordinal
   * it was written at.
   *
   * `seq` is derived from the stored maximum inside the same transaction as
   * the insert, never from a counter held in the caller. A counter would
   * restart at zero in the process that reopens the database — which is the
   * one case this whole table exists for.
   *
   * A terminal `done` event ALSO resolves the conversation's status, in that
   * same transaction. Splitting them would let a crash land between the two
   * and leave a conversation carrying a recorded `done` while still reading
   * `'running'` — a row that would then be reported as interrupted despite
   * having plainly finished. Because they are atomic,
   * {@link CuratorDb.reconcileInterruptedConversations} can trust the status
   * column alone.
   */
  appendConversationEvent(conversationId: string, event: LibrarianEvent, recordedAt: number): number {
    try {
      return this.db.transaction((): number => {
        const conversation = this.db.prepare('SELECT status FROM conversations WHERE id = ?').get(conversationId) as
          | { status: string }
          | undefined;
        if (!conversation) throw new Error(`Unknown conversation turn ${conversationId}`);
        if (conversation.status !== 'running') {
          throw new Error(`Conversation turn ${conversationId} is already ${conversation.status}`);
        }
        const row = this.db
          .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM conversation_events WHERE conversation_id = ?')
          .get(conversationId) as { next: number };
        const seq = row.next;
        this.db
          .prepare(
            `INSERT INTO conversation_events (conversation_id, seq, type, payload, recorded_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(conversationId, seq, event.type, JSON.stringify(event), recordedAt);
        if (event.type === 'done') {
          this.db
            .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
            .run(event.status, recordedAt, conversationId);
        } else {
          this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(recordedAt, conversationId);
        }
        this.db.prepare(
          `UPDATE conversation_threads SET updated_at = ?
           WHERE id = (SELECT thread_id FROM conversations WHERE id = ?)`
        ).run(recordedAt, conversationId);
        return seq;
      })();
    } catch (err) {
      throw new DBError(`Failed to append ${event.type} event to conversation ${conversationId}`, err);
    }
  }

  /** The conversation record, or `null` when no such id was ever opened. */
  getConversation(id: string): PersistedConversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id ?? row.id,
      question: row.question,
      turnIndex: row.turn_index ?? 0,
      status: row.status as PersistedConversationStatus,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  }

  listConversationThreads(
    limit: number,
    cursor?: ConversationListCursor
  ): { items: PersistedConversationThreadSummary[]; nextCursor: ConversationListCursor | null } {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const cursorSql = cursor
      ? 'WHERE (t.created_at < ? OR (t.created_at = ? AND t.id < ?))'
      : '';
    const params = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id, boundedLimit + 1] : [boundedLimit + 1];
    const rows = this.db.prepare(`
      SELECT t.id, t.created_at, t.updated_at,
        (SELECT COUNT(*) FROM conversations c WHERE c.thread_id = t.id) AS turn_count,
        (SELECT c.status FROM conversations c WHERE c.thread_id = t.id ORDER BY c.turn_index DESC LIMIT 1) AS latest_status,
        (SELECT c.question FROM conversations c WHERE c.thread_id = t.id ORDER BY c.turn_index DESC LIMIT 1) AS latest_question
      FROM conversation_threads t
      ${cursorSql}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ?
    `).all(...params) as Array<ConversationThreadRow & {
      turn_count: number;
      latest_status: string;
      latest_question: string | null;
    }>;
    const page = rows.slice(0, boundedLimit);
    const items = page.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      turnCount: row.turn_count,
      latestStatus: row.latest_status as PersistedConversationStatus,
      latestQuestion: row.latest_question,
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > boundedLimit && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  getConversationThread(
    id: string,
    limit = 20,
    cursor?: ConversationDetailCursor
  ): PersistedConversationThreadPage | null {
    const thread = this.db.prepare('SELECT * FROM conversation_threads WHERE id = ?').get(id) as ConversationThreadRow | undefined;
    if (!thread) return null;
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const cursorSql = cursor
      ? `AND (
          c.turn_index > ? OR
          (c.turn_index = ? AND c.id > ?) OR
          (c.turn_index = ? AND c.id = ? AND COALESCE(e.seq, -1) > ?)
        )`
      : '';
    const params = cursor
      ? [
          id,
          cursor.turnIndex,
          cursor.turnIndex,
          cursor.id,
          cursor.turnIndex,
          cursor.id,
          cursor.eventSeq,
          boundedLimit + 1,
        ]
      : [id, boundedLimit + 1];
    const rows = this.db.prepare(
      `SELECT c.*,
         e.seq AS event_seq,
         e.type AS event_type,
         e.payload AS event_payload,
         e.recorded_at AS event_recorded_at
       FROM conversations c
       LEFT JOIN conversation_events e ON e.conversation_id = c.id
       WHERE c.thread_id = ? ${cursorSql}
       ORDER BY c.turn_index, c.id, COALESCE(e.seq, -1)
       LIMIT ?`
    ).all(...params) as ConversationDetailRow[];
    const page = rows.slice(0, boundedLimit);
    const last = page[page.length - 1];
    const turns: PersistedConversationTurn[] = [];
    for (const row of page) {
      let turn = turns[turns.length - 1];
      if (!turn || turn.id !== row.id) {
        turn = {
          id: row.id,
          threadId: row.thread_id ?? row.id,
          question: row.question,
          turnIndex: row.turn_index ?? 0,
          status: row.status as PersistedConversationStatus,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          events: [],
        };
        turns.push(turn);
      }
      if (row.event_seq !== null && row.event_payload !== null && row.event_recorded_at !== null) {
        try {
          turn.events.push({
            seq: row.event_seq,
            event: librarianEventSchema.parse(JSON.parse(row.event_payload)),
            recordedAt: row.event_recorded_at,
          });
        } catch (err) {
          throw new DBError(`Conversation ${row.id} has an unreadable event at seq ${row.event_seq}`, err);
        }
      }
    }
    return {
      id: thread.id,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      turns,
      nextCursor: rows.length > boundedLimit && last
        ? {
            threadId: id,
            turnIndex: last.turn_index ?? 0,
            id: last.id,
            eventSeq: last.event_seq ?? -1,
          }
        : null,
    };
  }

  /** Recent successful turns used only as bounded conversational continuity.
   * The caller still selects answer prose and never treats these events as
   * fresh retrieval evidence. */
  getConversationHistoryTurns(id: string, limit: number): PersistedConversationTurn[] | null {
    if (!this.hasConversationThread(id)) return null;
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT * FROM conversations
       WHERE thread_id = ? AND status = 'answered' AND question IS NOT NULL
       ORDER BY turn_index DESC, id DESC
       LIMIT ?`
    ).all(id, boundedLimit) as ConversationRow[];
    return rows.reverse().map((row) => ({
      id: row.id,
      threadId: row.thread_id ?? row.id,
      question: row.question,
      turnIndex: row.turn_index ?? 0,
      status: row.status as PersistedConversationStatus,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      events: this.getConversationEvents(row.id),
    }));
  }

  /**
   * Every recorded event for a conversation, in the order it was emitted —
   * what the Desk replays to rebuild a feed after a reload or a restart.
   *
   * Throws on a row whose payload no longer parses as a `LibrarianEvent`
   * rather than skipping it. A silently shortened feed is the failure mode
   * §10.E exists to prevent, wearing a different hat: it renders as a
   * complete conversation that is missing a step, and nothing about it looks
   * wrong.
   */
  getConversationEvents(conversationId: string): PersistedConversationEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_events WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as ConversationEventRow[];
    return rows.map((row) => {
      let event: LibrarianEvent;
      try {
        event = librarianEventSchema.parse(JSON.parse(row.payload));
      } catch (err) {
        throw new DBError(`Conversation ${conversationId} has an unreadable event at seq ${row.seq}`, err);
      }
      return { seq: row.seq, event, recordedAt: row.recorded_at };
    });
  }

  /**
   * Resolve every conversation still recorded as `'running'` to
   * `'interrupted'`, returning how many were rewritten. Call ONCE per
   * process, at startup, before any conversation of this process's own can
   * open — see {@link PersistedConversationStatus} for why that timing makes
   * this an observation rather than a guess, and why `'interrupted'` is the
   * only honest verdict available for a run whose end nobody saw.
   *
   * Deliberately narrow: it touches `'running'` rows only. A conversation
   * that recorded a terminal `done` keeps the status that event carried —
   * rewriting those would destroy real outcomes to tidy up unreal ones.
   */
  reconcileInterruptedConversations(now: number): number {
    try {
      return this.db.transaction(() => {
        const affected = this.db.prepare("SELECT DISTINCT thread_id FROM conversations WHERE status = 'running'")
          .all() as Array<{ thread_id: string }>;
        const result = this.db
          .prepare("UPDATE conversations SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
          .run(now);
        const updateThread = this.db.prepare('UPDATE conversation_threads SET updated_at = ? WHERE id = ?');
        for (const row of affected) updateThread.run(now, row.thread_id);
        return result.changes;
      })();
    } catch (err) {
      throw new DBError('Failed to reconcile interrupted conversations', err);
    }
  }

  /**
   * Per book, the union of categories any recorded run has ever attempted.
   * A book with no `tag_runs` rows at all — including every book that
   * predates this table — maps to an empty `Set`, never to a missing entry
   * a caller might mistake for "everything audited". When `bookIds` is
   * given, every id is present in the returned map (with an empty set if it
   * has no runs); when omitted, only books with at least one run appear —
   * callers should treat a missing key the same as an empty set.
   */
  getAuditedCategories(bookIds?: string[]): Map<string, Set<TagCategory>> {
    const result = new Map<string, Set<TagCategory>>();
    let rows: TagRunRow[];
    if (bookIds && bookIds.length > 0) {
      for (const id of bookIds) result.set(id, new Set());
      const placeholders = bookIds.map(() => '?').join(',');
      rows = this.db.prepare(`SELECT * FROM tag_runs WHERE book_id IN (${placeholders})`).all(...bookIds) as TagRunRow[];
    } else {
      rows = this.db.prepare('SELECT * FROM tag_runs').all() as TagRunRow[];
    }
    for (const row of rows) {
      const run = mapTagRun(row);
      let categories = result.get(run.bookId);
      if (!categories) {
        categories = new Set();
        result.set(run.bookId, categories);
      }
      for (const category of run.categories) categories.add(category);
    }
    return result;
  }

  /**
   * Resolve the canonical category for `tag` when no `category` was given in
   * a {@link TagFilter} passed to {@link CuratorDb.getTagCoverage}. Looks at
   * every category the tag has actually been recorded under (`book_tags`)
   * and every category it is defined under in the vocabulary (`vocab_terms`,
   * which can carry a term even before any book is tagged with it). Returns
   * that category only when both sources agree on exactly one; returns
   * `null` — "cannot be determined" — for a tag that has never been seen at
   * all, or one recorded under more than one category.
   */
  private resolveTagCategory(tag: string): TagCategory | null {
    const rows = this.db
      .prepare(
        `SELECT category FROM book_tags WHERE tag = ?
         UNION
         SELECT category FROM vocab_terms WHERE term = ?`
      )
      .all(tag, tag) as Array<{ category: string }>;
    const categories = new Set(rows.map((r) => r.category));
    return categories.size === 1 ? ([...categories][0] as TagCategory) : null;
  }

  private coverageBucket(bookIds: string[]): TagCoverageBucket {
    return { count: bookIds.length, bookIds: bookIds.slice(0, TAG_COVERAGE_ID_CAP) };
  }

  /**
   * The three-state coverage report behind the librarian's "none of these
   * five is tagged chosen-one; two haven't been trope-audited yet" sentence
   * (plan §5.4, §10.A). For each `filters` entry, classifies every candidate
   * book as `present` / `absent` / `unaudited` — see {@link TagCoverageEntry}.
   *
   * The candidate set is `options.bookIds` when given, otherwise every
   * active book — the same `sync_status='active'` scoping as
   * {@link CuratorDb.getAllBooks}. An explicitly-passed EMPTY `bookIds` means
   * an empty candidate set (every bucket reports zero) — deliberately NOT the
   * same as omitting `bookIds` entirely. This is handled here rather than by
   * widening {@link CuratorDb.getAllBooks} (whose `[]`-means-unscoped
   * behaviour other callers already depend on): otherwise a caller that
   * queries with a legitimately-empty survivor list — e.g. `excludeTags`
   * having removed every candidate — would silently get a report about the
   * entire library instead of an all-zero report about nothing.
   *
   * A requested id that is tombstoned, or never existed, simply does not
   * appear in `candidateIds` and so lands in none of the three buckets — a
   * caller computing `requested.length - present.count - absent.count -
   * unaudited.count` to infer "how many were dropped" will get a non-zero
   * number for exactly that reason, not an error.
   *
   * A tag present on a book but below `f.minConfidence` classifies as
   * `absent`, consistent with the same predicate `present` is computed from
   * — but note that reads as "the book does not carry this tag" when a
   * `book_tags` row for it does in fact exist, just under the confidence bar.
   */
  getTagCoverage(filters: TagFilter[], options?: { bookIds?: string[] }): TagCoverageReport {
    const bookIdsGiven = options?.bookIds !== undefined;
    const candidateIds =
      bookIdsGiven && options!.bookIds!.length === 0
        ? []
        : this.getAllBooks(options?.bookIds).map((b) => b.id);
    const audited = this.getAuditedCategories(candidateIds);

    const entries: TagCoverageEntry[] = filters.map((f) => {
      const category = f.category ?? this.resolveTagCategory(f.tag);

      let presentIds = new Set<string>();
      if (candidateIds.length > 0) {
        const params: unknown[] = [];
        const predicate = this.tagPredicate(f, params, false);
        const placeholders = candidateIds.map(() => '?').join(',');
        const rows = this.db
          .prepare(
            `SELECT DISTINCT bt.book_id FROM book_tags bt
             WHERE ${predicate} AND bt.book_id IN (${placeholders})`
          )
          .all(...params, ...candidateIds) as Array<{ book_id: string }>;
        presentIds = new Set(rows.map((r) => r.book_id));
      }

      const absentIds: string[] = [];
      const unauditedIds: string[] = [];
      for (const id of candidateIds) {
        if (presentIds.has(id)) continue;
        // `category` is only actionable when it was actually resolved — an
        // unresolved category means coverage cannot be verified, so the book
        // reports unaudited rather than a confident (and possibly wrong)
        // absent.
        //
        // `tag_runs` is trusted here without a corroborating tag count. That
        // is only safe because the write side now retracts a book's runs when
        // its tags are deleted (see `deleteBookTags`/`deleteTagTerm`). The
        // read side genuinely cannot distinguish "tags were wiped" from
        // "audited and legitimately produced none", and the earlier attempt to
        // infer it from a zero-tag count made the second case report
        // `unaudited` forever — invariant 6's produced-vs-attempted
        // conflation in mirror image.
        if (category && audited.get(id)?.has(category)) {
          absentIds.push(id);
        } else {
          unauditedIds.push(id);
        }
      }

      return {
        tag: f.tag,
        category,
        present: this.coverageBucket([...presentIds]),
        absent: this.coverageBucket(absentIds),
        unaudited: this.coverageBucket(unauditedIds),
      };
    });

    return { entries };
  }

  /**
   * Insert-or-update just these tags for a book, leaving every other tag row
   * intact — unlike {@link CuratorDb.replaceBookTags}, which wipes first.
   *
   * This exists so derived tags can be backfilled across the library without a
   * re-tag: `deriveTags` is a pure function of metadata the sync already holds,
   * so recomputing it costs nothing and must not disturb LLM output. Same
   * free-recompute shape as `rebuildBookEntities`.
   */
  upsertBookTags(bookId: string, tags: Array<GeneratedTag & { source: TagSource }>, taggedAt: number): number {
    try {
      const insert = this.db.prepare(
        `INSERT INTO book_tags (book_id, tag, category, confidence, tagged_at, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id, tag) DO UPDATE SET
           category = excluded.category,
           confidence = excluded.confidence,
           tagged_at = excluded.tagged_at,
           source = excluded.source`
      );
      const txn = this.db.transaction((items: Array<GeneratedTag & { source: TagSource }>) => {
        let written = 0;
        for (const t of items) {
          insert.run(bookId, t.tag, t.category, t.confidence, taggedAt, t.source);
          written += 1;
        }
        return written;
      });
      return txn(tags);
    } catch (err) {
      throw new DBError(`Failed to upsert tags for book ${bookId}`, err);
    }
  }

  countTaggedBooks(): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT book_id) AS c FROM book_tags')
      .get() as { c: number };
    return row.c;
  }

  /**
   * Raw counts behind the library-readiness signal (plan §10.D). Every count
   * is scoped to ACTIVE books, so a tombstoned book neither inflates the
   * denominator nor counts as covered.
   *
   * This method deliberately reports only counts and never a percentage or a
   * verdict. The distinction that matters for invariant 5 — "the check said
   * no" versus "the check never ran" — is carried by the paired
   * `*Attempted` / `*Unknown` counts, and turning those into a percentage
   * (or into `Unknown`) is `core/readiness.ts`'s job. Both halves of each
   * pair have to come from here, because only SQL can tell them apart.
   */
  getReadinessCounts(opts: { schemaVersion: number; embeddingModel: string | null }): ReadinessCounts {
    const scalar = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { c: number }).c;

    const active = "b.sync_status='active'";
    return {
      totalBooks: this.countActiveBooks(),
      // "Enrichment ANSWERED for this book" — a row of status 'ok' or
      // 'not-found'. Without this count, a library that has never been
      // enriched is indistinguishable from one where every provider missed,
      // and 0% would mean "we never looked".
      //
      // 'error' is deliberately NOT counted. `enricher.ts` writes it on any
      // provider exception — outage, 429, DNS, bad key — which is a check
      // that could not complete, not a check that came back negative. Folding
      // it in here made a rate-limited run over 955 books report a confident
      // "0% have external metadata", byte-identical to the all-missed case,
      // and instructed the librarian to state it. That is invariant 5 inside
      // the feature built to enforce invariant 5. Errored books fall into
      // `unknown`, where a retry can still change the answer.
      enrichmentAttempted: scalar(
        `SELECT COUNT(DISTINCT b.id) AS c FROM books b
         JOIN external_metadata em ON em.book_id = b.id
         WHERE ${active} AND em.status IN ('ok','not-found')`
      ),
      externalResolved: scalar(
        `SELECT COUNT(DISTINCT b.id) AS c FROM books b
         JOIN external_metadata em ON em.book_id = b.id
         WHERE ${active} AND em.status = 'ok'`
      ),
      withEntities: scalar(
        `SELECT COUNT(DISTINCT b.id) AS c FROM books b
         JOIN book_entities be ON be.book_id = b.id
         WHERE ${active} AND be.kind IN ('person','place')`
      ),
      taggedAtVersion: scalar(
        `SELECT COUNT(DISTINCT b.id) AS c FROM books b
         JOIN tag_runs tr ON tr.book_id = b.id
         WHERE ${active} AND tr.schema_version = ?`,
        opts.schemaVersion
      ),
      // Tagged, but at an unrecorded schema version: `book_tags` rows with no
      // `tag_runs` row at all. Every book tagged before `tag_runs` existed is
      // in here. We know it WAS tagged; we do not know against which schema,
      // and inventing 'not at the current version' for it would be a
      // confident number standing in for a check that cannot succeed.
      taggedVersionUnknown: scalar(
        `SELECT COUNT(DISTINCT b.id) AS c FROM books b
         JOIN book_tags bt ON bt.book_id = b.id
         WHERE ${active} AND NOT EXISTS (SELECT 1 FROM tag_runs tr WHERE tr.book_id = b.id)`
      ),
      // Embeddings are model-specific: a vector produced by a different model
      // is not comparable to one produced by the configured model, so it is
      // NOT coverage. `embeddedAnyModel` exists so the caller can say
      // "embedded under another model" rather than silently reading 0%.
      embeddedAtModel:
        opts.embeddingModel === null || opts.embeddingModel === ''
          ? 0
          : scalar(
              `SELECT COUNT(DISTINCT b.id) AS c FROM books b
               JOIN book_embeddings emb ON emb.book_id = b.id
               WHERE ${active} AND emb.model = ?`,
              opts.embeddingModel
            ),
      embeddedAnyModel: scalar(
        `SELECT COUNT(DISTINCT b.id) AS c FROM books b
         JOIN book_embeddings emb ON emb.book_id = b.id WHERE ${active}`
      ),
    };
  }

  /** Per-tagged-book category coverage, for tag-quality validation (Task 2.6). */
  getBookCategoryCoverage(): { bookId: string; title: string; categories: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT b.id AS id, b.title AS title, GROUP_CONCAT(DISTINCT bt.category) AS cats
         FROM books b JOIN book_tags bt ON bt.book_id = b.id
         GROUP BY b.id`
      )
      .all() as { id: string; title: string; cats: string | null }[];
    return rows.map((r) => ({
      bookId: r.id,
      title: r.title,
      categories: r.cats ? r.cats.split(',') : [],
    }));
  }

  /** Tags whose confidence falls outside [0,1], for validation. */
  getOutOfRangeConfidences(): { bookId: string; tag: string; confidence: number }[] {
    const rows = this.db
      .prepare('SELECT book_id, tag, confidence FROM book_tags WHERE confidence < 0 OR confidence > 1')
      .all() as { book_id: string; tag: string; confidence: number }[];
    return rows.map((r) => ({ bookId: r.book_id, tag: r.tag, confidence: r.confidence }));
  }

  getTagVocabulary(): TagVocabularyEntry[] {
    const rows = this.db
      .prepare(
        `SELECT tag, category, COUNT(*) AS count FROM book_tags
         GROUP BY tag, category ORDER BY count DESC, tag`
      )
      .all() as { tag: string; category: string; count: number }[];
    return rows.map((r) => ({ tag: r.tag, category: r.category as TagCategory, count: r.count }));
  }

  // ── tag_aliases / vocab_terms (Migration C: canonicalization + promotion queue) ─

  /** Upsert a raw-form → canonical alias, scoped per category. */
  upsertTagAlias(alias: string, canonical: string, category: TagCategory): void {
    try {
      this.db
        .prepare(
          `INSERT INTO tag_aliases (alias, canonical, category) VALUES (?, ?, ?)
           ON CONFLICT(alias, category) DO UPDATE SET canonical = excluded.canonical`
        )
        .run(alias, canonical, category);
    } catch (err) {
      throw new DBError(`Failed to upsert tag alias ${alias}/${category}`, err);
    }
  }

  getTagAlias(alias: string, category: TagCategory): TagAlias | null {
    const row = this.db
      .prepare('SELECT * FROM tag_aliases WHERE alias = ? AND category = ?')
      .get(alias, category) as TagAliasRow | undefined;
    return row ? mapTagAlias(row) : null;
  }

  /** Vocabulary terms, optionally restricted to `statuses`, ordered by category then term. */
  getVocabTerms(statuses?: VocabTermStatus[]): VocabTerm[] {
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM vocab_terms WHERE status IN (${placeholders}) ORDER BY category, term`)
        .all(...statuses) as VocabTermRow[];
      return rows.map(mapVocabTerm);
    }
    const rows = this.db
      .prepare('SELECT * FROM vocab_terms ORDER BY category, term')
      .all() as VocabTermRow[];
    return rows.map(mapVocabTerm);
  }

  /** True iff `term` is an in-vocabulary (seed or promoted) term for `category`. */
  isVocabTerm(term: string, category: TagCategory): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM vocab_terms WHERE term = ? AND category = ? AND status IN ('seed','promoted')`)
      .get(term, category);
    return row !== undefined;
  }

  /**
   * Upsert a vocab term's status. Inserting a brand-new row sets book_count=0
   * and first_seen=`now`; updating an existing row only touches `status` —
   * book_count/first_seen are left as-is.
   */
  setVocabTermStatus(term: string, category: TagCategory, status: VocabTermStatus, now: number): void {
    try {
      this.db
        .prepare(
          `INSERT INTO vocab_terms (term, category, status, book_count, first_seen)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(term, category) DO UPDATE SET status = excluded.status`
        )
        .run(term, category, status, now);
    } catch (err) {
      throw new DBError(`Failed to set vocab term status for ${term}/${category}`, err);
    }
  }

  /**
   * Resolve a selection of proposals atomically. Bulk promotion refuses terms
   * that are live in another category; callers may still resolve those one at
   * a time after reviewing the ambiguity. Re-embedding intentionally happens
   * outside this transaction, once, over the returned de-duplicated ids.
   */
  reviewVocabTerms(items: VocabReviewItem[], action: VocabBatchAction): VocabBatchResult {
    try {
      const txn = this.db.transaction((): VocabBatchResult => {
        const proposed = this.db.prepare(
          `SELECT 1 FROM vocab_terms WHERE term = ? AND category = ? AND status = 'proposed'`
        );
        const otherCategory = this.db.prepare(
          `SELECT 1 FROM vocab_terms
           WHERE term = ? AND category != ? AND status IN ('seed','proposed','promoted') LIMIT 1`
        );
        const missing = items.filter((item) => !proposed.get(item.term, item.category));
        const collisions = action === 'promote'
          ? items.filter((item) => Boolean(otherCategory.get(item.term, item.category)))
          : [];
        if (missing.length > 0 || collisions.length > 0) {
          return { action, reviewed: 0, retagged: 0, bookIds: [], missing, collisions };
        }

        const setStatus = this.db.prepare('UPDATE vocab_terms SET status = ? WHERE term = ? AND category = ?');
        const taggedRows = this.db.prepare(
          `SELECT id, book_id FROM book_tags WHERE tag = ? AND category = ? AND source = 'llm-open'`
        );
        const promoteTag = this.db.prepare(`UPDATE book_tags SET source = 'vocab' WHERE id = ?`);
        const bookIds = new Set<string>();
        let retagged = 0;

        for (const item of items) {
          setStatus.run(action === 'promote' ? 'promoted' : 'rejected', item.term, item.category);
          if (action !== 'promote') continue;
          const rows = taggedRows.all(item.term, item.category) as Array<{ id: number; book_id: string }>;
          for (const row of rows) {
            promoteTag.run(row.id);
            retagged += 1;
            bookIds.add(row.book_id);
          }
        }

        return {
          action,
          reviewed: items.length,
          retagged,
          bookIds: [...bookIds],
          missing: [],
          collisions: [],
        };
      });
      return txn();
    } catch (err) {
      throw new DBError(`Failed to ${action} vocabulary terms in bulk`, err);
    }
  }

  /**
   * Recompute (not increment) the promotion queue from current `book_tags`
   * (source='llm-open') state, in one transaction:
   *  - a (tag, category) pair with no vocab_terms row yet is inserted as
   *    'proposed', origin='tagger', tagger_book_count/book_count = its count
   *  - ANY existing 'proposed' row (whichever origin created it) has its
   *    `tagger_book_count` refreshed to this pass's true count, and
   *    `book_count` recomputed as `MAX(tagger_book_count, enrichment_book_count)`
   *    — see the CREATE TABLE comment on why neither signal alone is "the"
   *    count once both passes evidence a term. This is what keeps a term's
   *    displayed count live even when {@link refreshEnrichmentVocabProposals}
   *    created the row first (origin='enrichment'): ownership of the ROW
   *    (who may delete it) and ownership of ONE OF ITS TWO COUNTS are
   *    different things, and only the former is origin-scoped.
   *  - seed/promoted/rejected rows are never touched (even if they collide
   *    with an llm-open tag — they simply don't get a count update from this
   *    path)
   *  - a 'proposed' row this pass no longer evidences (present in the table,
   *    absent from this run's `counts`) has `tagger_book_count` zeroed and
   *    `book_count` recomputed the same way, so a stale nonzero count is
   *    never left behind — same reasoning `refreshEnrichmentVocabProposals`
   *    applies to `enrichment_book_count`
   *  - a 'proposed', origin='tagger' row is DELETED only once BOTH counts
   *    have hit zero — an origin='enrichment' row is never deleted here even
   *    if `tagger_book_count` reaches zero, because `refreshEnrichmentVocabProposals`
   *    still owns its lifecycle (and vice versa): without that origin scope
   *    on the DELETE, this method (called unconditionally by
   *    `GET /vocab/proposed`) could wipe a row the other pass still needs,
   *    since an enrichment-origin proposal deliberately has no backing
   *    `book_tags` row of `source='llm-open'` (R1 writes no `book_tags` rows
   *    at all) and would otherwise look exactly like an orphan to this query.
   */
  refreshProposedVocabCounts(now: number): void {
    try {
      const txn = this.db.transaction(() => {
        const counts = this.db
          .prepare(
            `SELECT tag AS term, category, COUNT(DISTINCT book_id) AS c
             FROM book_tags WHERE source = 'llm-open'
             GROUP BY tag, category`
          )
          .all() as { term: string; category: string; c: number }[];

        const upsert = this.db.prepare(
          `INSERT INTO vocab_terms (term, category, status, book_count, tagger_book_count, enrichment_book_count, first_seen, origin)
           VALUES (@term, @category, 'proposed', @c, @c, 0, @now, 'tagger')
           ON CONFLICT(term, category) DO UPDATE SET
             tagger_book_count = @c,
             book_count = MAX(@c, vocab_terms.enrichment_book_count)
           WHERE vocab_terms.status = 'proposed'`
        );
        for (const row of counts) {
          upsert.run({ term: row.term, category: row.category, c: row.c, now });
        }

        const keep = new Set(counts.map((r) => `${r.category} ${r.term}`));
        const stale = this.db
          .prepare(`SELECT term, category FROM vocab_terms WHERE status = 'proposed' AND tagger_book_count > 0`)
          .all() as { term: string; category: string }[];
        const clearStale = this.db.prepare(
          `UPDATE vocab_terms SET tagger_book_count = 0, book_count = enrichment_book_count
           WHERE term = ? AND category = ?`
        );
        for (const row of stale) {
          if (keep.has(`${row.category} ${row.term}`)) continue;
          clearStale.run(row.term, row.category);
        }

        this.db
          .prepare(
            `DELETE FROM vocab_terms
             WHERE status = 'proposed'
               AND origin = 'tagger'
               AND tagger_book_count = 0
               AND enrichment_book_count = 0`
          )
          .run();
      });
      txn();
    } catch (err) {
      throw new DBError('Failed to refresh proposed vocab counts', err);
    }
  }

  /**
   * R1's sibling of {@link refreshProposedVocabCounts}: recompute (not
   * increment) the `enrichment_book_count` slice of the promotion queue from
   * `rows` — the cached-provider-subjects proposals
   * `core/enrichment/promoteSubjects.ts` just computed, library-wide, from
   * `external_metadata` (never from `book_tags`, which this method never
   * reads). Same recompute-and-GC shape, scoped the other way:
   *  - a (term, category) pair with no vocab_terms row yet is inserted as
   *    'proposed', origin='enrichment', enrichment_book_count/book_count =
   *    its count
   *  - ANY existing 'proposed' row (whichever origin created it) has its
   *    `enrichment_book_count` refreshed and `book_count` recomputed as
   *    `MAX(tagger_book_count, enrichment_book_count)` — see the CREATE TABLE
   *    comment and {@link refreshProposedVocabCounts}'s docblock for why a
   *    tagger-origin row's count is still kept live here rather than frozen
   *    at whatever the tagger pass last wrote
   *  - a 'seed'/'promoted'/'rejected' row is never touched
   *  - a 'proposed' row absent from `rows` this run has `enrichment_book_count`
   *    zeroed and `book_count` recomputed, so a stale nonzero count is never
   *    left behind
   *  - a 'proposed', origin='enrichment' row is DELETED only once BOTH counts
   *    have hit zero — an origin='tagger' row is never deleted here, the
   *    exact mirror of the origin scope on {@link refreshProposedVocabCounts}'s
   *    DELETE, and for the same reason: a term this method no longer
   *    evidences may still have live `book_tags` the tagger pass owns.
   *
   * Both statements run inside one transaction. Returns the number of rows
   * actually DELETED (pruned) — never counts a row that merely had its
   * `enrichment_book_count` zeroed while a tagger-side count kept it alive —
   * so a caller reporting "N pruned" is reporting rows genuinely gone.
   */
  refreshEnrichmentVocabProposals(
    rows: Array<{ term: string; category: TagCategory; bookCount: number }>,
    now: number
  ): number {
    try {
      const txn = this.db.transaction((): number => {
        const upsert = this.db.prepare(
          `INSERT INTO vocab_terms (term, category, status, book_count, tagger_book_count, enrichment_book_count, first_seen, origin)
           VALUES (@term, @category, 'proposed', @c, 0, @c, @now, 'enrichment')
           ON CONFLICT(term, category) DO UPDATE SET
             enrichment_book_count = @c,
             book_count = MAX(vocab_terms.tagger_book_count, @c)
           WHERE vocab_terms.status = 'proposed'`
        );
        for (const row of rows) {
          upsert.run({ term: row.term, category: row.category, c: row.bookCount, now });
        }

        const keep = new Set(rows.map((r) => `${r.category} ${r.term}`));
        const stale = this.db
          .prepare(`SELECT term, category FROM vocab_terms WHERE status = 'proposed' AND enrichment_book_count > 0`)
          .all() as { term: string; category: string }[];
        // Zero the stale count first, THEN re-check for deletion — a row
        // stays alive if `tagger_book_count` (untouched by this pass) is
        // still positive; only `del`'s WHERE, evaluated after the UPDATE,
        // can tell the two cases apart.
        const clearStale = this.db.prepare(
          `UPDATE vocab_terms SET enrichment_book_count = 0, book_count = tagger_book_count
           WHERE term = ? AND category = ?`
        );
        const del = this.db.prepare(
          `DELETE FROM vocab_terms
           WHERE term = ? AND category = ?
             AND status = 'proposed'
             AND origin = 'enrichment'
             AND tagger_book_count = 0
             AND enrichment_book_count = 0`
        );
        let pruned = 0;
        for (const row of stale) {
          if (keep.has(`${row.category} ${row.term}`)) continue;
          clearStale.run(row.term, row.category);
          const info = del.run(row.term, row.category);
          if (info.changes > 0) pruned += 1;
        }
        return pruned;
      });
      return txn();
    } catch (err) {
      throw new DBError('Failed to refresh enrichment vocab proposals', err);
    }
  }

  /** Proposed terms ordered by usage volume, each with up to `sampleTitles` example book titles. */
  getProposedVocabTerms(sampleTitles = 3): Array<VocabTerm & { sampleBooks: string[] }> {
    const terms = this.db
      .prepare(`SELECT * FROM vocab_terms WHERE status = 'proposed' ORDER BY book_count DESC, term`)
      .all() as VocabTermRow[];

    const sampleStmt = this.db.prepare(
      `SELECT DISTINCT b.title FROM book_tags bt
         JOIN books b ON b.id = bt.book_id
       WHERE bt.tag = ? AND bt.category = ? AND bt.source = 'llm-open'
       ORDER BY b.title
       LIMIT ?`
    );

    return terms.map((row) => {
      const samples = sampleStmt.all(row.term, row.category, sampleTitles) as { title: string }[];
      return { ...mapVocabTerm(row), sampleBooks: samples.map((s) => s.title) };
    });
  }

  /** Every active book carrying one proposed llm-open term, for on-demand
   * review. The route resolves effective descriptions so this query remains a
   * narrow data accessor rather than duplicating description precedence. */
  getBooksForProposedTerm(term: string, category: TagCategory): Book[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT b.* FROM book_tags bt
         JOIN books b ON b.id = bt.book_id AND b.sync_status = 'active'
         WHERE bt.tag = ? AND bt.category = ? AND bt.source = 'llm-open'
         ORDER BY b.title`
      )
      .all(term, category) as BookRow[];
    return rows.map(mapBook);
  }

  /**
   * Rename every llm-open `fromTag`/`category` row to `toTag`, promoting its
   * source to 'vocab'. If a book already carries `toTag` on a *different* row
   * (UNIQUE(book_id, tag) would collide), the from-row is deleted instead of
   * updated. The collision check excludes the row being retagged itself, so
   * calling this with `fromTag === toTag` (promoting a term to itself, just
   * to flip its source) updates in place rather than self-deleting. Returns
   * the number of book_tags rows changed (updated + deleted) and the
   * distinct book ids touched — the caller (vocab promote/alias routes)
   * needs the ids to scope a follow-up re-embed (readiness plan item B) to
   * exactly the affected books, not the whole library.
   */
  retagLlmOpenTags(fromTag: string, category: TagCategory, toTag: string): { changed: number; bookIds: string[] } {
    try {
      const txn = this.db.transaction((): { changed: number; bookIds: string[] } => {
        const rows = this.db
          .prepare(`SELECT id, book_id FROM book_tags WHERE tag = ? AND category = ? AND source = 'llm-open'`)
          .all(fromTag, category) as { id: number; book_id: string }[];

        const hasTarget = this.db.prepare('SELECT 1 FROM book_tags WHERE book_id = ? AND tag = ? AND id != ?');
        const del = this.db.prepare('DELETE FROM book_tags WHERE id = ?');
        const upd = this.db.prepare(`UPDATE book_tags SET tag = ?, source = 'vocab' WHERE id = ?`);

        let changed = 0;
        const bookIds = new Set<string>();
        for (const row of rows) {
          const collision = hasTarget.get(row.book_id, toTag, row.id);
          if (collision) {
            del.run(row.id);
          } else {
            upd.run(toTag, row.id);
          }
          changed++;
          bookIds.add(row.book_id);
        }
        return { changed, bookIds: [...bookIds] };
      });
      return txn();
    } catch (err) {
      throw new DBError(`Failed to retag llm-open tags from ${fromTag} to ${toTag}`, err);
    }
  }

  // ── external_metadata (enrichment cache) ────────────────────────────────────

  /**
   * Upsert the cached response of one enrichment provider lookup for one book.
   * `payload` is serialized verbatim (JSON.stringify); null/undefined payload
   * (the not-found/error case) is stored as SQL NULL.
   */
  upsertExternalMetadata(rec: ExternalMetadataRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO external_metadata (book_id, provider, payload, fetched_at, status)
           VALUES (@bookId, @provider, @payload, @fetchedAt, @status)
           ON CONFLICT(book_id, provider) DO UPDATE SET
             payload = excluded.payload,
             fetched_at = excluded.fetched_at,
             status = excluded.status`
        )
        .run({
          bookId: rec.bookId,
          provider: rec.provider,
          payload: rec.payload === null || rec.payload === undefined ? null : JSON.stringify(rec.payload),
          fetchedAt: rec.fetchedAt,
          status: rec.status,
        });
    } catch (err) {
      throw new DBError(`Failed to upsert external metadata for book ${rec.bookId}/${rec.provider}`, err);
    }
  }

  /** All cached provider records for a book. A malformed stored payload decodes as null. */
  getExternalMetadata(bookId: string): ExternalMetadataRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM external_metadata WHERE book_id = ? ORDER BY provider')
      .all(bookId) as ExternalMetadataRow[];
    return rows.map(mapExternalMetadata);
  }

  /** All cached metadata for active books, used by on-demand review reports
   * that must reconstruct provider evidence without an N+1 query loop. */
  getExternalMetadataForActiveBooks(): ExternalMetadataRecord[] {
    const rows = this.db
      .prepare(
        `SELECT em.* FROM external_metadata em
         JOIN books b ON b.id = em.book_id AND b.sync_status = 'active'
         ORDER BY em.book_id, em.provider`
      )
      .all() as ExternalMetadataRow[];
    return rows.map(mapExternalMetadata);
  }

  getExternalMetadataForProvider(bookId: string, provider: string): ExternalMetadataRecord | null {
    const row = this.db
      .prepare('SELECT * FROM external_metadata WHERE book_id = ? AND provider = ?')
      .get(bookId, provider) as ExternalMetadataRow | undefined;
    return row ? mapExternalMetadata(row) : null;
  }

  /**
   * Active books that are due for a re-lookup against `provider`: no cached
   * row, a cached 'error' (always retried), or a stale 'ok'/'not-found' row
   * past its respective TTL. Restrict to `bookIds` when given.
   *
   * `refreshBefore` ignores the TTLs and instead returns every active book
   * whose cached row predates that timestamp (plus every book with no row).
   * The cache is keyed on the book, not on the *query* we sent — so after the
   * titles improve, every cached 'not-found' is stale in a way no timestamp
   * can express, and a normal run reports zero candidates. That is the cache
   * working correctly and the workflow being wrong; a re-check is the escape
   * hatch. It costs a full re-fetch, so it is opt-in rather than automatic.
   *
   * It is a TIMESTAMP rather than a boolean because a re-check of a whole
   * library does not necessarily fit in one run. A boolean "ignore the cache"
   * re-listed all 961 books `ORDER BY title` on every attempt, so a run that
   * died partway — a provider's daily quota, a cancel, a restart — restarted
   * from the head of the alphabet and re-spent the same budget on the same
   * books, never reaching the tail. Pinning the epoch to when the re-check
   * *campaign* began makes the rows written since then count as done, so a
   * repeat run advances instead of looping. The cache is still the cursor;
   * `refreshBefore` is just what the cursor is compared against.
   */
  getEnrichmentCandidates(
    provider: string,
    opts: { okTtlMs: number; notFoundTtlMs: number; now: number; bookIds?: string[]; refreshBefore?: number }
  ): Book[] {
    const where: string[] = ["b.sync_status='active'"];
    const params: unknown[] = [];
    if (opts.bookIds && opts.bookIds.length > 0) {
      const placeholders = opts.bookIds.map(() => '?').join(',');
      where.push(`b.id IN (${placeholders})`);
      params.push(...opts.bookIds);
    }
    if (opts.refreshBefore !== undefined) {
      // Due unless this provider already answered for the book at or after the
      // campaign epoch. Status is deliberately ignored: a re-check re-asks
      // 'ok', 'not-found' and 'error' alike, and only "we already re-asked
      // this one" excuses a book.
      where.push(`NOT EXISTS (
        SELECT 1 FROM external_metadata em
         WHERE em.book_id = b.id AND em.provider = ? AND em.fetched_at >= ?
      )`);
      params.push(provider, opts.refreshBefore);
      const rows = this.db
        .prepare(`SELECT b.* FROM books b WHERE ${where.join(' AND ')} ORDER BY b.title`)
        .all(...params) as BookRow[];
      return rows.map(mapBook);
    }
    const okThreshold = opts.now - opts.okTtlMs;
    const notFoundThreshold = opts.now - opts.notFoundTtlMs;
    where.push(`(
      NOT EXISTS (SELECT 1 FROM external_metadata em WHERE em.book_id = b.id AND em.provider = ?)
      OR EXISTS (
        SELECT 1 FROM external_metadata em WHERE em.book_id = b.id AND em.provider = ?
          AND (
            em.status = 'error'
            OR (em.status = 'ok' AND em.fetched_at < ?)
            OR (em.status = 'not-found' AND em.fetched_at < ?)
          )
      )
    )`);
    params.push(provider, provider, okThreshold, notFoundThreshold);

    const rows = this.db
      .prepare(`SELECT b.* FROM books b WHERE ${where.join(' AND ')} ORDER BY b.title`)
      .all(...params) as BookRow[];
    return rows.map(mapBook);
  }

  // ── title parsing (librarian engine plan: filename-derived title recovery) ──

  /**
   * Active books with no `title_parse` yet — the candidate pool for
   * `titleParser.ts`'s run, restricted to `opts.bookIds` when given (same
   * scoping shape as {@link CuratorDb.getEnrichmentCandidates}).
   *
   * `reparse` drops the not-yet-parsed condition so an improved parser can be
   * applied to a library that has already been through one. Without it, a run
   * after a parser fix is a silent no-op — and that is precisely the state a
   * real library is in the moment it has been parsed once. Re-parsing is safe
   * by construction: `updateTitleParse` rewrites only the derived columns and
   * still fills author/year via COALESCE, so nothing already set is touched.
   */
  getBooksNeedingTitleParse(opts?: { bookIds?: string[]; reparse?: boolean }): Book[] {
    const where: string[] = ["b.sync_status='active'"];
    if (!opts?.reparse) where.push('b.title_parse IS NULL');
    const params: unknown[] = [];
    if (opts?.bookIds && opts.bookIds.length > 0) {
      const placeholders = opts.bookIds.map(() => '?').join(',');
      where.push(`b.id IN (${placeholders})`);
      params.push(...opts.bookIds);
    }
    const rows = this.db
      .prepare(`SELECT b.* FROM books b WHERE ${where.join(' AND ')} ORDER BY b.title`)
      .all(...params) as BookRow[];
    return rows.map(mapBook);
  }

  /**
   * Persist one title-parse result. `normalized_title` and the full
   * `title_parse` JSON are always written (so candidates and the ordinal
   * survive for later re-processing); `title_meta_source` records provenance
   * for whichever of `harvested.author`/`harvested.publishedYear` are
   * supplied. `books.title` is NEVER written here — the parse only ever
   * annotates a book, never replaces its title.
   *
   * `harvested.author`/`harvested.publishedYear` are applied to the `books`
   * columns via `COALESCE`, so this call can never overwrite an existing
   * author or published year even if a caller passes one in error — "fill
   * nulls only" is enforced at the SQL layer, not just trusted from the caller.
   *
   * `parse.ordinal` is deliberately never written to `series_sequence` here
   * (or anywhere in this pipeline) — see titleParse.ts's docblock: the same
   * leading-number syntax means a personal list position under one naming
   * convention and a story index under another, and a wrong series number
   * silently reorders a real series. It survives only inside the stored
   * `title_parse` JSON.
   *
   * `parse.series`/`parse.seriesSequence` ARE written, under the same
   * COALESCE fill-nulls-only rule. They come from a `<Series> <NN> - <Title>`
   * segment, where the series is named right next to the number, so the
   * ambiguity that makes `ordinal` untrustworthy does not apply — `Pern 09`
   * says which series it is counting. A book that already has a series or a
   * sequence keeps it.
   */
  updateTitleParse(
    bookId: string,
    parse: TitleParse,
    harvested: { author?: string | null; publishedYear?: number | null } = {}
  ): void {
    try {
      const metaSource: Record<string, string> = {};
      if (harvested.author) metaSource.author = 'title-parse';
      if (harvested.publishedYear) metaSource.publishedYear = 'title-parse';
      if (parse.series) metaSource.series = 'title-parse';
      if (parse.seriesSequence !== null) metaSource.seriesSequence = 'title-parse';
      this.db
        .prepare(
          `UPDATE books SET
             normalized_title = @normalizedTitle,
             title_parse = @titleParse,
             title_meta_source = @titleMetaSource,
             author = COALESCE(author, @author),
             published_year = COALESCE(published_year, @publishedYear),
             series = COALESCE(series, @series),
             series_sequence = COALESCE(series_sequence, @seriesSequence)
           WHERE id = @bookId`
        )
        .run({
          bookId,
          normalizedTitle: parse.normalizedTitle,
          titleParse: JSON.stringify(parse),
          titleMetaSource: Object.keys(metaSource).length > 0 ? JSON.stringify(metaSource) : null,
          author: harvested.author ?? null,
          publishedYear: harvested.publishedYear ?? null,
          series: parse.series ?? null,
          seriesSequence: parse.seriesSequence ?? null,
        });
    } catch (err) {
      throw new DBError(`Failed to update title parse for book ${bookId}`, err);
    }
  }

  // ── book_entities (grounded entities) ───────────────────────────────────────

  /**
   * Replace ALL entities for a book in a single transaction (same C2
   * replace-not-append semantics as {@link CuratorDb.replaceBookTags}).
   * Populated by enrichment only, never by the tagger directly.
   *
   * `notable` defaults to true when omitted, matching the column's DEFAULT 1
   * — a caller that doesn't compute notability (fixtures, older call sites)
   * gets today's "everything counts" behaviour rather than silently hiding
   * entities it never scored.
   */
  replaceBookEntities(
    bookId: string,
    entities: Array<{ entity: string; kind: EntityKind; sources: string[]; notable?: boolean }>
  ): void {
    try {
      const txn = this.db.transaction(
        (items: Array<{ entity: string; kind: EntityKind; sources: string[]; notable?: boolean }>) => {
          this.db.prepare('DELETE FROM book_entities WHERE book_id = ?').run(bookId);
          const insert = this.db.prepare(
            `INSERT INTO book_entities (book_id, entity, kind, sources, notable) VALUES (?, ?, ?, ?, ?)`
          );
          for (const e of items) {
            insert.run(bookId, e.entity, e.kind, JSON.stringify(e.sources), e.notable === false ? 0 : 1);
          }
        }
      );
      txn(entities);
    } catch (err) {
      throw new DBError(`Failed to replace entities for book ${bookId}`, err);
    }
  }

  /**
   * All entities for a book, ordered by kind then entity. `notableOnly`
   * restricts to the flagged-notable subset (see the `BookEntity.notable`
   * docblock) — additive and optional so every existing caller keeps
   * getting the full allowlist unless it explicitly opts in.
   */
  getEntitiesForBook(bookId: string, opts?: { notableOnly?: boolean }): BookEntity[] {
    const sql = opts?.notableOnly
      ? 'SELECT * FROM book_entities WHERE book_id = ? AND notable = 1 ORDER BY kind, entity'
      : 'SELECT * FROM book_entities WHERE book_id = ? ORDER BY kind, entity';
    const rows = this.db.prepare(sql).all(bookId) as BookEntityRow[];
    return rows.map(mapBookEntity);
  }

  /**
   * Cross-book entity frequency: normalized (trimmed, lowercased) entity
   * text -> number of distinct active books carrying it, optionally scoped
   * to one `kind`. Feeds {@link scoreNotability}'s high-frequency penalty —
   * a name recurring across many books (`God`, `Jones`, `Chopin`) is a
   * concordance artifact, not a cast member. Deleted books are excluded so
   * a tombstoned book's entities don't keep depressing another book's score.
   */
  /**
   * Ids of every active (non-tombstoned) book, in stable id order.
   *
   * Deliberately ids rather than full `Book` rows: `rederive.ts` walks the
   * whole library and only needs a key to look up cached metadata, so
   * materialising ~950 full books (description text included) just to read
   * their ids would be wasteful.
   */
  getActiveBookIds(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM books WHERE sync_status='active' ORDER BY id")
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getEntityBookCounts(kind?: EntityKind): Map<string, number> {
    const params: unknown[] = [];
    let sql = `SELECT LOWER(TRIM(be.entity)) AS norm, COUNT(DISTINCT be.book_id) AS c
               FROM book_entities be
               JOIN books b ON b.id = be.book_id AND b.sync_status = 'active'`;
    if (kind) {
      sql += ' WHERE be.kind = ?';
      params.push(kind);
    }
    sql += ' GROUP BY norm';
    const rows = this.db.prepare(sql).all(...params) as { norm: string; c: number }[];
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.norm, row.c);
    return counts;
  }

  // ── book_embeddings / book_edges ────────────────────────────────────────

  upsertBookEmbedding(rec: BookEmbedding): void {
    try {
      const buf = Buffer.from(rec.vector.buffer, rec.vector.byteOffset, rec.vector.byteLength);
      this.db
        .prepare(
          `INSERT INTO book_embeddings (book_id, model, card_hash, vector)
           VALUES (@bookId, @model, @cardHash, @vector)
           ON CONFLICT(book_id) DO UPDATE SET
             model = excluded.model,
             card_hash = excluded.card_hash,
             vector = excluded.vector`
        )
        .run({
          bookId: rec.bookId,
          model: rec.model,
          cardHash: rec.cardHash,
          vector: buf,
        });
    } catch (err) {
      throw new DBError(`Failed to upsert embedding for book ${rec.bookId}`, err);
    }
  }

  getBookEmbedding(bookId: string): BookEmbedding | null {
    const row = this.db
      .prepare('SELECT * FROM book_embeddings WHERE book_id = ?')
      .get(bookId) as BookEmbeddingRow | undefined;
    return row ? mapBookEmbedding(row) : null;
  }

  /** Every stored embedding, optionally restricted to one model. */
  getAllBookEmbeddings(model?: string): BookEmbedding[] {
    const rows = model
      ? (this.db
          .prepare('SELECT * FROM book_embeddings WHERE model = ? ORDER BY book_id')
          .all(model) as BookEmbeddingRow[])
      : (this.db
          .prepare('SELECT * FROM book_embeddings ORDER BY book_id')
          .all() as BookEmbeddingRow[]);
    return rows.map(mapBookEmbedding);
  }

  /** bookId -> {model, cardHash} for cheap staleness checks without loading BLOBs. */
  getEmbeddingCardHashes(): Map<string, { model: string; cardHash: string }> {
    const rows = this.db
      .prepare('SELECT book_id, model, card_hash FROM book_embeddings')
      .all() as Array<{ book_id: string; model: string; card_hash: string }>;
    const result = new Map<string, { model: string; cardHash: string }>();
    for (const r of rows) result.set(r.book_id, { model: r.model, cardHash: r.card_hash });
    return result;
  }

  deleteBookEmbedding(bookId: string): number {
    const info = this.db.prepare('DELETE FROM book_embeddings WHERE book_id = ?').run(bookId);
    return info.changes;
  }

  countBookEmbeddings(model?: string): number {
    const row = model
      ? (this.db.prepare('SELECT COUNT(*) AS c FROM book_embeddings WHERE model = ?').get(model) as { c: number })
      : (this.db.prepare('SELECT COUNT(*) AS c FROM book_embeddings').get() as { c: number });
    return row.c;
  }

  /**
   * Every active book with its stored embedding identity, ordered by book id.
   * `storedModel`/`storedCardHash` are null when the book has never been
   * embedded (the LEFT JOIN found no `book_embeddings` row). This is the
   * only candidate selector `embedder.ts` uses — the db layer cannot
   * decide staleness itself (that needs a composed card hash, which requires
   * tags + entities assembled in TypeScript), so it just hands back the raw
   * identity pair for `isEmbeddingStale` to judge.
   *
   * `options.bookIds` restricts the pool (still filtered to active books).
   */
  getStaleEmbeddings(options?: { bookIds?: string[] }): EmbeddingCandidate[] {
    const where: string[] = ["b.sync_status='active'"];
    const params: unknown[] = [];
    if (options?.bookIds && options.bookIds.length > 0) {
      const placeholders = options.bookIds.map(() => '?').join(',');
      where.push(`b.id IN (${placeholders})`);
      params.push(...options.bookIds);
    }

    const rows = this.db
      .prepare(
        `SELECT b.*, e.model AS embedding_model, e.card_hash AS embedding_card_hash
         FROM books b
         LEFT JOIN book_embeddings e ON e.book_id = b.id
         WHERE ${where.join(' AND ')}
         ORDER BY b.id`
      )
      .all(...params) as StaleEmbeddingRow[];

    return rows.map((row) => ({
      book: mapBook(row),
      storedModel: row.embedding_model,
      storedCardHash: row.embedding_card_hash,
    }));
  }

  /**
   * Replace all edges of one (fromBook, relation, source) triple in a
   * transaction (same C2 replace-not-append semantics as
   * {@link CuratorDb.replaceBookTags}).
   */
  replaceBookEdges(
    fromBook: string,
    relation: EdgeRelation,
    source: EdgeSource,
    edges: Array<{ toBook: string; score: number | null }>
  ): void {
    try {
      const txn = this.db.transaction((items: Array<{ toBook: string; score: number | null }>) => {
        this.db
          .prepare('DELETE FROM book_edges WHERE from_book = ? AND relation = ? AND source = ?')
          .run(fromBook, relation, source);
        const insert = this.db.prepare(
          `INSERT INTO book_edges (from_book, to_book, relation, score, source) VALUES (?, ?, ?, ?, ?)`
        );
        for (const e of items) {
          insert.run(fromBook, e.toBook, relation, e.score, source);
        }
      });
      txn(edges);
    } catch (err) {
      throw new DBError(`Failed to replace edges for book ${fromBook}`, err);
    }
  }

  getEdgesForBook(fromBook: string, relation?: EdgeRelation): BookEdge[] {
    const rows = relation
      ? (this.db
          .prepare('SELECT * FROM book_edges WHERE from_book = ? AND relation = ? ORDER BY score DESC, to_book')
          .all(fromBook, relation) as BookEdgeRow[])
      : (this.db
          .prepare('SELECT * FROM book_edges WHERE from_book = ? ORDER BY relation, score DESC, to_book')
          .all(fromBook) as BookEdgeRow[]);
    return rows.map(mapBookEdge);
  }

  // ── feedback & personalization (Migration E: plan §1.6, §6) ──────────────

  /** Record one verdict. Returns the new row id. */
  insertRecFeedback(input: {
    bookId: string | null;
    externalKey?: string | null;
    queryText: string;
    verdict: FeedbackVerdict;
    source?: FeedbackSource;
    weight?: number;
    createdAt: number;
  }): number {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO rec_feedback (book_id, external_key, query_text, verdict, source, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.bookId,
          input.externalKey ?? null,
          input.queryText,
          input.verdict,
          input.source ?? 'explicit',
          input.weight ?? 1,
          input.createdAt
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      throw new DBError('Failed to insert recommendation feedback', err);
    }
  }

  /**
   * Replace the implicit verdict for one book.
   *
   * Listening-derived feedback is a *restatement of current state*, not an
   * event: re-syncing must not append a second `abandoned` row every time,
   * or the taste profile would weight a book by how often sync ran. Explicit
   * rows are never touched — a deliberate thumbs-down outlives any amount of
   * re-listening.
   */
  upsertImplicitFeedback(input: {
    bookId: string;
    queryText: string;
    verdict: FeedbackVerdict;
    weight: number;
    createdAt: number;
  }): void {
    const replace = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM rec_feedback WHERE book_id = ? AND source = 'implicit'")
        .run(input.bookId);
      this.db
        .prepare(
          `INSERT INTO rec_feedback (book_id, external_key, query_text, verdict, source, weight, created_at)
           VALUES (?, NULL, ?, ?, 'implicit', ?, ?)`
        )
        .run(input.bookId, input.queryText, input.verdict, input.weight, input.createdAt);
    });
    try {
      replace();
    } catch (err) {
      throw new DBError(`Failed to upsert implicit feedback for ${input.bookId}`, err);
    }
  }

  /** Feedback rows, newest first. `since` bounds by `created_at`. */
  getRecFeedback(options: { since?: number; limit?: number } = {}): RecFeedback[] {
    const limit = options.limit ?? 500;
    const rows = (options.since !== undefined
      ? this.db
          .prepare('SELECT * FROM rec_feedback WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(options.since, limit)
      : this.db
          .prepare('SELECT * FROM rec_feedback ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(limit)) as RecFeedbackRow[];
    return rows.map(mapRecFeedback);
  }

  /** Record a whole displayed slate in one transaction. */
  insertRecImpressions(
    slateId: string,
    queryText: string,
    rows: ReadonlyArray<{ bookId: string | null; externalKey?: string | null; rank: number; score?: number | null }>,
    shownAt: number
  ): void {
    if (rows.length === 0) return;
    const insert = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO rec_impressions (slate_id, query_text, book_id, external_key, rank, score, shown_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of rows) {
        stmt.run(slateId, queryText, row.bookId, row.externalKey ?? null, row.rank, row.score ?? null, shownAt);
      }
    });
    try {
      insert();
    } catch (err) {
      throw new DBError(`Failed to record impressions for slate ${slateId}`, err);
    }
  }

  /** Every impression row of one slate, in displayed order. */
  getRecImpressions(slateId: string): RecImpression[] {
    const rows = this.db
      .prepare('SELECT * FROM rec_impressions WHERE slate_id = ? ORDER BY rank')
      .all(slateId) as RecImpressionRow[];
    return rows.map(mapRecImpression);
  }

  /** Upsert the progress snapshot for one book. */
  upsertListeningProgress(input: ListeningProgress): void {
    try {
      this.db
        .prepare(
          `INSERT INTO listening_progress
             (book_id, progress, is_finished, started_at, finished_at, time_listening, last_played_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(book_id) DO UPDATE SET
             progress = excluded.progress,
             is_finished = excluded.is_finished,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             time_listening = excluded.time_listening,
             last_played_at = excluded.last_played_at,
             updated_at = excluded.updated_at`
        )
        .run(
          input.bookId,
          input.progress,
          input.isFinished ? 1 : 0,
          input.startedAt,
          input.finishedAt,
          input.timeListening,
          input.lastPlayedAt,
          input.updatedAt
        );
    } catch (err) {
      throw new DBError(`Failed to upsert listening progress for ${input.bookId}`, err);
    }
  }

  getListeningProgress(bookId: string): ListeningProgress | null {
    const row = this.db
      .prepare('SELECT * FROM listening_progress WHERE book_id = ?')
      .get(bookId) as ListeningProgressRow | undefined;
    return row ? mapListeningProgress(row) : null;
  }

  /** Every progress snapshot. Small by construction — one row per started book. */
  getAllListeningProgress(): ListeningProgress[] {
    const rows = this.db
      .prepare('SELECT * FROM listening_progress ORDER BY book_id')
      .all() as ListeningProgressRow[];
    return rows.map(mapListeningProgress);
  }

  /** Insert sessions, ignoring ids already stored — re-syncing a window is safe. */
  insertListeningSessions(sessions: readonly ListeningSession[]): number {
    if (sessions.length === 0) return 0;
    let inserted = 0;
    const insert = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO listening_sessions (id, book_id, started_at, duration, playback_speed, device)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const s of sessions) {
        const result = stmt.run(s.id, s.bookId, s.startedAt, s.duration, s.playbackSpeed, s.device);
        inserted += result.changes;
      }
    });
    try {
      insert();
      return inserted;
    } catch (err) {
      throw new DBError('Failed to insert listening sessions', err);
    }
  }

  getListeningSessions(options: { bookId?: string; limit?: number } = {}): ListeningSession[] {
    const limit = options.limit ?? 1000;
    const rows = (options.bookId !== undefined
      ? this.db
          .prepare('SELECT * FROM listening_sessions WHERE book_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(options.bookId, limit)
      : this.db
          .prepare('SELECT * FROM listening_sessions ORDER BY started_at DESC LIMIT ?')
          .all(limit)) as ListeningSessionRow[];
    return rows.map(mapListeningSession);
  }

  // ── collections ──────────────────────────────────────────────────────────

  insertCollection(input: {
    name: string;
    description: string | null;
    theme: string;
    status?: CollectionStatus;
    createdAt: number;
    libraryId?: string | null;
    ownershipMarker?: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO collections (name, description, theme, status, created_at, library_id, ownership_marker)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.description,
        input.theme,
        input.status ?? 'proposed',
        input.createdAt,
        input.libraryId ?? null,
        input.ownershipMarker ?? null
      );
    return Number(info.lastInsertRowid);
  }

  getCollection(id: number): Collection | undefined {
    const row = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
      | CollectionRow
      | undefined;
    return row ? mapCollection(row) : undefined;
  }

  listCollections(status?: CollectionStatus): Collection[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM collections WHERE status = ? ORDER BY created_at DESC')
          .all(status) as CollectionRow[])
      : (this.db
          .prepare('SELECT * FROM collections ORDER BY created_at DESC')
          .all() as CollectionRow[]);
    return rows.map(mapCollection);
  }

  /** Most recent collection generated from a given theme (template id / prompt). */
  findCollectionByTheme(theme: string): Collection | undefined {
    const row = this.db
      .prepare('SELECT * FROM collections WHERE theme = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(theme) as CollectionRow | undefined;
    return row ? mapCollection(row) : undefined;
  }

  findCollectionsByName(name: string): Collection[] {
    const rows = this.db
      .prepare('SELECT * FROM collections WHERE name = ? ORDER BY created_at DESC')
      .all(name) as CollectionRow[];
    return rows.map(mapCollection);
  }

  updateCollectionStatus(
    id: number,
    status: CollectionStatus,
    extra: { absCollectionId?: string; pushedAt?: number } = {}
  ): void {
    this.db
      .prepare(
        `UPDATE collections SET
           status = ?,
           abs_collection_id = COALESCE(?, abs_collection_id),
           pushed_at = COALESCE(?, pushed_at)
         WHERE id = ?`
      )
      .run(status, extra.absCollectionId ?? null, extra.pushedAt ?? null, id);
  }

  updateCollectionMeta(id: number, meta: { name?: string; description?: string | null }): void {
    this.db
      .prepare(
        `UPDATE collections SET
           name = COALESCE(?, name),
           description = CASE WHEN ? THEN ? ELSE description END
         WHERE id = ?`
      )
      .run(meta.name ?? null, meta.description !== undefined ? 1 : 0, meta.description ?? null, id);
  }

  claimCollection(id:number,libraryId:string,marker:string):void { this.db.prepare('UPDATE collections SET library_id=?,ownership_marker=? WHERE id=?').run(libraryId,marker,id); }

  deleteCollection(id: number): void {
    try {
      const txn = this.db.transaction(() => {
        this.db.prepare('DELETE FROM collection_books WHERE collection_id = ?').run(id);
        this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
      });
      txn();
    } catch (err) {
      throw new DBError(`Failed to delete collection ${id}`, err);
    }
  }

  // ── collection_books ──────────────────────────────────────────────────────

  /** Replace the book membership of a collection (idempotent). */
  setCollectionBooks(collectionId: number, books: { bookId: string; sortOrder: number }[]): void {
    try {
      const txn = this.db.transaction(() => {
        this.db.prepare('DELETE FROM collection_books WHERE collection_id = ?').run(collectionId);
        const insert = this.db.prepare(
          `INSERT INTO collection_books (collection_id, book_id, sort_order) VALUES (?, ?, ?)`
        );
        for (const b of books) insert.run(collectionId, b.bookId, b.sortOrder);
      });
      txn();
    } catch (err) {
      throw new DBError(`Failed to set books for collection ${collectionId}`, err);
    }
  }

  getCollectionBooks(collectionId: number): CollectionBook[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM collection_books WHERE collection_id = ? ORDER BY sort_order, book_id'
      )
      .all(collectionId) as CollectionBookRow[];
    return rows.map(mapCollectionBook);
  }

  /** Books in a collection, joined to full book rows, ordered by sort_order. */
  getCollectionBooksDetailed(collectionId: number): Book[] {
    const rows = this.db
      .prepare(
        `SELECT b.* FROM collection_books cb
           JOIN books b ON b.id = cb.book_id
         WHERE cb.collection_id = ?
         ORDER BY cb.sort_order, b.title`
      )
      .all(collectionId) as BookRow[];
    return rows.map(mapBook);
  }

  updateCollectionBookOrder(collectionId: number, order: { bookId: string; sortOrder: number }[]): void {
    const txn = this.db.transaction(() => {
      const update = this.db.prepare(
        'UPDATE collection_books SET sort_order = ? WHERE collection_id = ? AND book_id = ?'
      );
      for (const o of order) update.run(o.sortOrder, collectionId, o.bookId);
    });
    txn();
  }

  // ── sync_log ───────────────────────────────────────────────────────────────

  startLog(operation: SyncOperation, startedAt: number): number {
    const info = this.db
      .prepare(`INSERT INTO sync_log (operation, status, started_at) VALUES (?, 'running', ?)`)
      .run(operation, startedAt);
    return Number(info.lastInsertRowid);
  }

  finishLog(id: number, status: SyncStatus, detail: unknown, finishedAt: number): void {
    this.db
      .prepare('UPDATE sync_log SET status = ?, detail = ?, finished_at = ? WHERE id = ?')
      .run(status, detail === undefined || detail === null ? null : JSON.stringify(detail), finishedAt, id);
  }

  getRecentLogs(limit: number): SyncLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM sync_log ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SyncLogRow[];
    return rows.map(mapSyncLog);
  }

  allLogs(): SyncLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM sync_log ORDER BY started_at DESC')
      .all() as SyncLogRow[];
    return rows.map(mapSyncLog);
  }

  /**
   * Average observed input/output tokens per book across the most recent
   * successful (non-dry-run) `tag` runs — backs the frontend's cost
   * estimate. `finishLog` stores `{ ...TaggingResult, cancelled }` as the
   * `detail` JSON (see tagger.ts), so `processed` and `tokensUsed` are read
   * straight off it. Dry runs (no tokens spent) and runs that tagged zero
   * books are skipped; a run with a malformed/unexpected detail blob is
   * skipped rather than thrown. Returns null when there's no usable history
   * yet, so the caller can fall back to a hardcoded estimate.
   */
  getAverageTagTokenUsage(maxRuns = 20): { inputTokensPerBook: number; outputTokensPerBook: number; sampleSize: number } | null {
    const rows = this.db
      .prepare("SELECT * FROM sync_log WHERE operation = 'tag' AND status = 'success' ORDER BY started_at DESC LIMIT ?")
      .all(maxRuns) as SyncLogRow[];

    let inputTokens = 0;
    let outputTokens = 0;
    let books = 0;
    for (const row of rows) {
      const detail = mapSyncLog(row).detail as
        | { dryRun?: boolean; processed?: number; tokensUsed?: { inputTokens?: number; outputTokens?: number } }
        | null;
      if (!detail || typeof detail !== 'object' || detail.dryRun) continue;
      const processed = Number(detail.processed) || 0;
      if (processed <= 0 || !detail.tokensUsed) continue;
      inputTokens += Number(detail.tokensUsed.inputTokens) || 0;
      outputTokens += Number(detail.tokensUsed.outputTokens) || 0;
      books += processed;
    }

    if (books === 0) return null;
    return {
      inputTokensPerBook: inputTokens / books,
      outputTokensPerBook: outputTokens / books,
      sampleSize: books,
    };
  }

  /**
   * The most recent re-check campaign, read back out of `sync_log`.
   *
   * A campaign can outlive many runs (see `getEnrichmentCandidates`'s
   * `refreshBefore`), and the in-memory operation registry does not survive a
   * restart, so the epoch has to be recoverable from somewhere durable.
   * `finishLog` already stores the whole `EnrichmentResult` as `detail`, so
   * the epoch is read straight off the newest 'enrich' run that carried one.
   *
   * Dry runs are included on purpose: planning a re-check is how a user
   * previews one, and it must not silently start a *different* campaign from
   * the run that follows it.
   */
  getLatestRefreshCampaign(maxRuns = 50): { refreshBefore: number; startedAt: number } | null {
    const rows = this.db
      .prepare("SELECT * FROM sync_log WHERE operation = 'enrich' ORDER BY started_at DESC LIMIT ?")
      .all(maxRuns) as SyncLogRow[];

    for (const row of rows) {
      const entry = mapSyncLog(row);
      const detail = entry.detail as { refreshBefore?: unknown } | null;
      if (!detail || typeof detail !== 'object') continue;
      const refreshBefore = Number(detail.refreshBefore);
      if (!Number.isFinite(refreshBefore)) continue;
      return { refreshBefore, startedAt: entry.startedAt };
    }
    return null;
  }

  getLastLog(operation?: SyncOperation): SyncLogEntry | undefined {
    let row;
    if (operation) {
      row = this.db
        .prepare('SELECT * FROM sync_log WHERE operation = ? ORDER BY started_at DESC LIMIT 1')
        .get(operation) as SyncLogRow | undefined;
    } else {
      row = this.db
        .prepare('SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 1')
        .get() as SyncLogRow | undefined;
    }
    return row ? mapSyncLog(row) : undefined;
  }

  // ── encode_candidates ────────────────────────────────────────────────────────

  getEncodeCandidates(libraryId: string): EncodeCandidate[] {
    const rows = this.db
      .prepare('SELECT * FROM encode_candidates WHERE library_id = ?')
      .all(libraryId) as any[];
    
    return rows.map((r) => ({
      libraryItemId: r.library_item_id,
      libraryId: r.library_id,
      name: r.name,
      author: r.author,
      files: JSON.parse(r.files_json) as string[],
      totalBytes: r.total_bytes,
    }));
  }

  removeEncodeCandidate(libraryItemId: string): void {
    this.db.prepare('DELETE FROM encode_candidates WHERE library_item_id = ?').run(libraryItemId);
  }

  replaceEncodeCandidates(libraryId: string, candidates: EncodeCandidate[]): void {
    const txn = this.db.transaction(() => {
      // Clear old candidates for this library
      this.db.prepare('DELETE FROM encode_candidates WHERE library_id = ?').run(libraryId);
      
      const insert = this.db.prepare(`
        INSERT INTO encode_candidates
          (library_item_id, library_id, name, author, files_json, total_bytes)
        VALUES
          (@libraryItemId, @libraryId, @name, @author, @filesJson, @totalBytes)
      `);
      
      for (const c of candidates) {
        insert.run({
          libraryItemId: c.libraryItemId,
          libraryId: c.libraryId,
          name: c.name,
          author: c.author,
          filesJson: JSON.stringify(c.files),
          totalBytes: c.totalBytes,
        });
      }
    });
    txn();
  }

  // ── encode_queue ──────────────────────────────────────────────────────────────

  insertEncodeQueueItem(item: NewEncodeQueueItem): void {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO encode_queue
             (id, library_id, name, author, total_bytes, status, sort_order, added_at)
           VALUES (@id, @libraryId, @name, @author, @totalBytes, 'queued', @sortOrder, @addedAt)`
        )
        .run(item);
    } catch (err) {
      throw new DBError('Failed to insert encode queue item', err);
    }
  }

  updateEncodeQueueItem(
    id: string,
    fields: {
      status?: EncodeJobStatus;
      sortOrder?: number;
      detail?: unknown;
    }
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (fields.status !== undefined) {
      sets.push('status = @status');
      params.status = fields.status;
    }
    if (fields.sortOrder !== undefined) {
      sets.push('sort_order = @sortOrder');
      params.sortOrder = fields.sortOrder;
    }
    if (fields.detail !== undefined) {
      sets.push('detail = @detail');
      params.detail = fields.detail === null ? null : JSON.stringify(fields.detail);
    }
    if (sets.length === 0) return;
    try {
      this.db.prepare(`UPDATE encode_queue SET ${sets.join(', ')} WHERE id = @id`).run(params);
    } catch (err) {
      throw new DBError(`Failed to update encode queue item ${id}`, err);
    }
  }

  listEncodeQueue(): EncodeQueueItem[] {
    const rows = this.db
      .prepare('SELECT * FROM encode_queue ORDER BY sort_order ASC, added_at ASC')
      .all() as EncodeQueueRow[];
    return rows.map(mapEncodeQueueItem);
  }

  getEncodeQueueItem(id: string): EncodeQueueItem | undefined {
    const row = this.db.prepare('SELECT * FROM encode_queue WHERE id = ?').get(id) as
      | EncodeQueueRow
      | undefined;
    return row ? mapEncodeQueueItem(row) : undefined;
  }

  removeEncodeQueueItem(id: string): void {
    try {
      this.db.prepare('DELETE FROM encode_queue WHERE id = ?').run(id);
    } catch (err) {
      throw new DBError(`Failed to delete encode queue item ${id}`, err);
    }
  }

  // ── encode_history ────────────────────────────────────────────────────────────

  insertEncodeHistoryItem(item: NewEncodeHistoryItem): number {
    try {
      const detailStr = item.detail === null || item.detail === undefined ? null : JSON.stringify(item.detail);
      const info = this.db
        .prepare(
          `INSERT INTO encode_history
             (library_item_id, name, author, total_bytes, status, started_at, detail)
           VALUES (@libraryItemId, @name, @author, @totalBytes, @status, @startedAt, @detail)`
        )
        .run({ ...item, detail: detailStr });
      return Number(info.lastInsertRowid);
    } catch (err) {
      throw new DBError('Failed to insert encode history item', err);
    }
  }

  updateEncodeHistoryItem(
    id: number,
    fields: {
      status?: string;
      finishedAt?: number | null;
      detail?: unknown;
    }
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (fields.status !== undefined) {
      sets.push('status = @status');
      params.status = fields.status;
    }
    if (fields.finishedAt !== undefined) {
      sets.push('finished_at = @finishedAt');
      params.finishedAt = fields.finishedAt;
    }
    if (fields.detail !== undefined) {
      sets.push('detail = @detail');
      params.detail = fields.detail === null ? null : JSON.stringify(fields.detail);
    }
    if (sets.length === 0) return;
    try {
      this.db.prepare(`UPDATE encode_history SET ${sets.join(', ')} WHERE id = @id`).run(params);
    } catch (err) {
      throw new DBError(`Failed to update encode history item ${id}`, err);
    }
  }

  listEncodeHistory(limit = 50): EncodeHistoryItem[] {
    const rows = this.db
      .prepare('SELECT * FROM encode_history ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as EncodeHistoryRow[];
    return rows.map(mapEncodeHistoryItem);
  }

  // ── export / import (Task 6.7) ──────────────────────────────────────────────

  exportTags(): { bookId: string; tags: { tag: string; category: TagCategory; confidence: number; source: TagSource }[] }[] {
    const rows = this.db
      .prepare('SELECT book_id, tag, category, confidence, source FROM book_tags ORDER BY book_id')
      .all() as { book_id: string; tag: string; category: string; confidence: number; source: string }[];
    const byBook = new Map<string, { tag: string; category: TagCategory; confidence: number; source: TagSource }[]>();
    for (const r of rows) {
      let list = byBook.get(r.book_id);
      if (!list) {
        list = [];
        byBook.set(r.book_id, list);
      }
      list.push({ tag: r.tag, category: r.category as TagCategory, confidence: r.confidence, source: r.source as TagSource });
    }
    return [...byBook.entries()].map(([bookId, tags]) => ({ bookId, tags }));
  }

  exportCollections(): {
    name: string;
    description: string | null;
    theme: string;
    status: CollectionStatus;
    bookIds: string[];
  }[] {
    return this.listCollections().map((c) => ({
      name: c.name,
      description: c.description,
      theme: c.theme,
      status: c.status,
      bookIds: this.getCollectionBooks(c.id).map((b) => b.bookId),
    }));
  }
}
