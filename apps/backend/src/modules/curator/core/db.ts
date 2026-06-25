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
  EncodeJob,
  EncodeJobStatus,
  EncodeMode,
  NewEncodeJob,
} from './encoder/encodeTypes.js';
import type {
  Book,
  BookTag,
  Collection,
  CollectionBook,
  CollectionStatus,
  GeneratedTag,
  SyncLogEntry,
  SyncOperation,
  SyncStatus,
  TagCategory,
} from './types.js';

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
}

interface BookTagRow {
  id: number;
  book_id: string;
  tag: string;
  category: string;
  confidence: number;
  tagged_at: number;
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

interface EncodeJobRow {
  id: number;
  operation_id: string;
  mode: string;
  status: string;
  audio_codec: string;
  bit_rate: string | null;
  candidate_count: number;
  done_count: number;
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

function mapEncodeJob(row: EncodeJobRow): EncodeJob {
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
    operationId: row.operation_id,
    mode: row.mode as EncodeMode,
    status: row.status as EncodeJobStatus,
    audioCodec: row.audio_codec,
    bitRate: row.bit_rate,
    candidateCount: row.candidate_count,
    doneCount: row.done_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    detail,
  };
}

// ── Query option shapes ───────────────────────────────────────────────────────

export interface BookQueryFilters {
  search?: string; // title/author LIKE
  author?: string;
  untagged?: boolean;
  tag?: string;
  category?: TagCategory;
  minConfidence?: number;
  limit?: number;
  offset?: number;
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

CREATE TABLE IF NOT EXISTS book_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id),
  tag TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  tagged_at INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS encode_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  audio_codec TEXT NOT NULL,
  bit_rate TEXT,
  candidate_count INTEGER NOT NULL,
  done_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_book_tags_book ON book_tags(book_id);
CREATE INDEX IF NOT EXISTS idx_book_tags_category ON book_tags(category);
CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag);
CREATE INDEX IF NOT EXISTS idx_collection_books_collection ON collection_books(collection_id);
CREATE INDEX IF NOT EXISTS idx_books_series ON books(series);
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
    } catch (err) {
      throw new DBError(`Failed to open database at ${dbPath}`, err);
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

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO books
               (id, title, author, series, series_sequence, duration_seconds,
                published_year, genres, description, cover_path, abs_added_at, last_synced_at)
             VALUES (@id, @title, @author, @series, @seriesSequence, @durationSeconds,
                @publishedYear, @genres, @description, @coverPath, @absAddedAt, @lastSyncedAt)`
          )
          .run({ ...book, genres: genresJson });
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
             last_synced_at=@lastSyncedAt
           WHERE id=@id`
        )
        .run({ ...book, genres: genresJson });
      return unchanged ? 'unchanged' : 'updated';
    } catch (err) {
      throw new DBError(`Failed to upsert book ${book.id}`, err);
    }
  }

  countBooks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM books').get() as { c: number };
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

  getAllBooks(): Book[] {
    const rows = this.db.prepare('SELECT * FROM books ORDER BY title').all() as BookRow[];
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

  queryBooks(filters: BookQueryFilters): BookQueryResult {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const where: string[] = [];
    const params: unknown[] = [];

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
      where.push(`EXISTS (SELECT 1 FROM book_tags bt WHERE ${tagWhere.join(' AND ')})`);
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
  replaceBookTags(bookId: string, tags: GeneratedTag[], taggedAt: number): void {
    try {
      const txn = this.db.transaction((items: GeneratedTag[]) => {
        this.db.prepare('DELETE FROM book_tags WHERE book_id = ?').run(bookId);
        const insert = this.db.prepare(
          `INSERT INTO book_tags (book_id, tag, category, confidence, tagged_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(book_id, tag) DO UPDATE SET
             category = excluded.category,
             confidence = excluded.confidence,
             tagged_at = excluded.tagged_at`
        );
        for (const t of items) {
          insert.run(bookId, t.tag, t.category, t.confidence, taggedAt);
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

  // ── collections ──────────────────────────────────────────────────────────

  insertCollection(input: {
    name: string;
    description: string | null;
    theme: string;
    status?: CollectionStatus;
    createdAt: number;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO collections (name, description, theme, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.description,
        input.theme,
        input.status ?? 'proposed',
        input.createdAt
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

  getRecentLogs(limit = 50): SyncLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM sync_log ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as SyncLogRow[];
    return rows.map(mapSyncLog);
  }

  getLastLog(operation?: SyncOperation): SyncLogEntry | undefined {
    const row = operation
      ? (this.db
          .prepare('SELECT * FROM sync_log WHERE operation = ? ORDER BY started_at DESC, id DESC LIMIT 1')
          .get(operation) as SyncLogRow | undefined)
      : (this.db
          .prepare('SELECT * FROM sync_log ORDER BY started_at DESC, id DESC LIMIT 1')
          .get() as SyncLogRow | undefined);
    return row ? mapSyncLog(row) : undefined;
  }

  /** Aggregate token usage recorded in sync_log.detail (Task 6.2). */
  allLogs(): SyncLogEntry[] {
    const rows = this.db.prepare('SELECT * FROM sync_log').all() as SyncLogRow[];
    return rows.map(mapSyncLog);
  }

  // ── encode_jobs ──────────────────────────────────────────────────────────────

  /** Persist a new encode job (history survives restarts; the registry does not). */
  insertEncodeJob(job: NewEncodeJob): number {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO encode_jobs
             (operation_id, mode, status, audio_codec, bit_rate, candidate_count, started_at)
           VALUES (@operationId, @mode, 'running', @audioCodec, @bitRate, @candidateCount, @startedAt)`
        )
        .run({ ...job, bitRate: job.bitRate ?? null });
      return Number(info.lastInsertRowid);
    } catch (err) {
      throw new DBError('Failed to insert encode job', err);
    }
  }

  /** Update progress/terminal state of an encode job. */
  updateEncodeJob(
    id: number,
    fields: {
      status?: EncodeJobStatus;
      doneCount?: number;
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
    if (fields.doneCount !== undefined) {
      sets.push('done_count = @doneCount');
      params.doneCount = fields.doneCount;
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
      this.db.prepare(`UPDATE encode_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
    } catch (err) {
      throw new DBError(`Failed to update encode job ${id}`, err);
    }
  }

  listEncodeJobs(limit = 50): EncodeJob[] {
    const rows = this.db
      .prepare('SELECT * FROM encode_jobs ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as EncodeJobRow[];
    return rows.map(mapEncodeJob);
  }

  getEncodeJob(id: number): EncodeJob | undefined {
    const row = this.db.prepare('SELECT * FROM encode_jobs WHERE id = ?').get(id) as
      | EncodeJobRow
      | undefined;
    return row ? mapEncodeJob(row) : undefined;
  }

  // ── export / import (Task 6.7) ──────────────────────────────────────────────

  exportTags(): { bookId: string; tags: { tag: string; category: TagCategory; confidence: number }[] }[] {
    const rows = this.db
      .prepare('SELECT book_id, tag, category, confidence FROM book_tags ORDER BY book_id')
      .all() as { book_id: string; tag: string; category: string; confidence: number }[];
    const byBook = new Map<string, { tag: string; category: TagCategory; confidence: number }[]>();
    for (const r of rows) {
      let list = byBook.get(r.book_id);
      if (!list) {
        list = [];
        byBook.set(r.book_id, list);
      }
      list.push({ tag: r.tag, category: r.category as TagCategory, confidence: r.confidence });
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
