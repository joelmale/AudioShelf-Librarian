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
import type {
  Book,
  BookEdge,
  BookEmbedding,
  BookEntity,
  BookTag,
  Collection,
  CollectionBook,
  CollectionStatus,
  EdgeRelation,
  EdgeSource,
  ExternalMetadataRecord,
  ExternalMetadataStatus,
  GeneratedTag,
  SyncLogEntry,
  SyncOperation,
  SyncStatus,
  TagAlias,
  TagCategory,
  TagSource,
  VocabTerm,
  VocabTermStatus,
} from './types.js';
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

interface VocabTermRow {
  term: string;
  category: string;
  status: string;
  book_count: number;
  first_seen: number;
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
  book_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_book_tags_book ON book_tags(book_id);
CREATE INDEX IF NOT EXISTS idx_book_tags_category ON book_tags(category);
CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag);
CREATE INDEX IF NOT EXISTS idx_collection_books_collection ON collection_books(collection_id);
CREATE INDEX IF NOT EXISTS idx_books_series ON books(series);
CREATE INDEX IF NOT EXISTS idx_book_entities_book ON book_entities(book_id);
CREATE INDEX IF NOT EXISTS idx_external_metadata_status ON external_metadata(provider, status, fetched_at);
CREATE INDEX IF NOT EXISTS idx_book_embeddings_model ON book_embeddings(model);
CREATE INDEX IF NOT EXISTS idx_book_edges_from ON book_edges(from_book, relation);
`;

/** Fields compared to classify an upsert as added / updated / unchanged. */
function bookContentEqual(existing: BookRow, next: Book): boolean {
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
    existing.abs_added_at === next.absAddedAt
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
      ['normalized_title','TEXT'], ['title_parse','TEXT'], ['title_meta_source','TEXT']
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
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(Date.now());
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_books_library_active ON books(library_id, sync_status)');
    });
    migrate();
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
      const params = { ...book, genres: genresJson, libraryId: book.libraryId ?? null,
        itemPath: book.itemPath ?? null, asin: book.asin ?? null, isbn: book.isbn ?? null,
        absUpdatedAt: book.absUpdatedAt ?? null, lastSeenSyncId: book.lastSeenSyncId ?? null };

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO books
               (id, title, author, series, series_sequence, duration_seconds,
                published_year, genres, description, cover_path, abs_added_at, last_synced_at,
                library_id, item_path, asin, isbn, abs_updated_at, last_seen_sync_id, sync_status, deleted_at)
             VALUES (@id, @title, @author, @series, @seriesSequence, @durationSeconds,
                @publishedYear, @genres, @description, @coverPath, @absAddedAt, @lastSyncedAt,
                @libraryId, @itemPath, @asin, @isbn, @absUpdatedAt, @lastSeenSyncId, 'active', NULL)`
          )
          .run(params);
        return 'added';
      }

      const unchanged = bookContentEqual(existing, book);
      // Always refresh last_synced_at so "last seen" is accurate even if unchanged.
      this.db
        .prepare(
          `UPDATE books SET
             title=@title, author=@author, series=@series, series_sequence=@seriesSequence,
             duration_seconds=@durationSeconds, published_year=@publishedYear, genres=@genres,
             description=@description, cover_path=@coverPath, abs_added_at=@absAddedAt,
             last_synced_at=@lastSyncedAt, library_id=@libraryId, item_path=@itemPath,
             asin=@asin, isbn=@isbn, abs_updated_at=@absUpdatedAt,
             last_seen_sync_id=@lastSeenSyncId, sync_status='active', deleted_at=NULL
           WHERE id=@id`
        )
        .run(params);
      return unchanged ? 'unchanged' : 'updated';
    } catch (err) {
      throw new DBError(`Failed to upsert book ${book.id}`, err);
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

  deleteBookTags(bookId: string): number {
    const info = this.db.prepare('DELETE FROM book_tags WHERE book_id = ?').run(bookId);
    return info.changes;
  }

  countTaggedBooks(): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT book_id) AS c FROM book_tags')
      .get() as { c: number };
    return row.c;
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
   * Recompute (not increment) the promotion queue from current `book_tags`
   * (source='llm-open') state, in one transaction:
   *  - a (tag, category) pair with no vocab_terms row yet is inserted as 'proposed'
   *  - an existing 'proposed' row has its book_count refreshed
   *  - seed/promoted/rejected rows are never touched (even if they collide with an
   *    llm-open tag — they simply don't get a book_count update from this path)
   *  - a 'proposed' row whose term no longer appears in any llm-open book_tags is deleted
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
          `INSERT INTO vocab_terms (term, category, status, book_count, first_seen)
           VALUES (@term, @category, 'proposed', @c, @now)
           ON CONFLICT(term, category) DO UPDATE SET book_count = @c
           WHERE vocab_terms.status = 'proposed'`
        );
        for (const row of counts) {
          upsert.run({ term: row.term, category: row.category, c: row.c, now });
        }

        this.db
          .prepare(
            `DELETE FROM vocab_terms
             WHERE status = 'proposed'
               AND NOT EXISTS (
                 SELECT 1 FROM book_tags bt
                 WHERE bt.tag = vocab_terms.term AND bt.category = vocab_terms.category AND bt.source = 'llm-open'
               )`
          )
          .run();
      });
      txn();
    } catch (err) {
      throw new DBError('Failed to refresh proposed vocab counts', err);
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

  /**
   * Rename every llm-open `fromTag`/`category` row to `toTag`, promoting its
   * source to 'vocab'. If a book already carries `toTag` on a *different* row
   * (UNIQUE(book_id, tag) would collide), the from-row is deleted instead of
   * updated. The collision check excludes the row being retagged itself, so
   * calling this with `fromTag === toTag` (promoting a term to itself, just
   * to flip its source) updates in place rather than self-deleting. Returns
   * the number of book_tags rows changed (updated + deleted).
   */
  retagLlmOpenTags(fromTag: string, category: TagCategory, toTag: string): number {
    try {
      const txn = this.db.transaction((): number => {
        const rows = this.db
          .prepare(`SELECT id, book_id FROM book_tags WHERE tag = ? AND category = ? AND source = 'llm-open'`)
          .all(fromTag, category) as { id: number; book_id: string }[];

        const hasTarget = this.db.prepare('SELECT 1 FROM book_tags WHERE book_id = ? AND tag = ? AND id != ?');
        const del = this.db.prepare('DELETE FROM book_tags WHERE id = ?');
        const upd = this.db.prepare(`UPDATE book_tags SET tag = ?, source = 'vocab' WHERE id = ?`);

        let changed = 0;
        for (const row of rows) {
          const collision = hasTarget.get(row.book_id, toTag, row.id);
          if (collision) {
            del.run(row.id);
          } else {
            upd.run(toTag, row.id);
          }
          changed++;
        }
        return changed;
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
   */
  getEnrichmentCandidates(
    provider: string,
    opts: { okTtlMs: number; notFoundTtlMs: number; now: number; bookIds?: string[] }
  ): Book[] {
    const where: string[] = ["b.sync_status='active'"];
    const params: unknown[] = [];
    if (opts.bookIds && opts.bookIds.length > 0) {
      const placeholders = opts.bookIds.map(() => '?').join(',');
      where.push(`b.id IN (${placeholders})`);
      params.push(...opts.bookIds);
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
      this.db
        .prepare(
          `UPDATE books SET
             normalized_title = @normalizedTitle,
             title_parse = @titleParse,
             title_meta_source = @titleMetaSource,
             author = COALESCE(author, @author),
             published_year = COALESCE(published_year, @publishedYear)
           WHERE id = @bookId`
        )
        .run({
          bookId,
          normalizedTitle: parse.normalizedTitle,
          titleParse: JSON.stringify(parse),
          titleMetaSource: Object.keys(metaSource).length > 0 ? JSON.stringify(metaSource) : null,
          author: harvested.author ?? null,
          publishedYear: harvested.publishedYear ?? null,
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
