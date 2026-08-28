import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { AcceptanceSnapshot } from './acceptance.js';
import { validateAcceptanceSnapshot } from './acceptance.js';

type SqlRow = Record<string, unknown>;

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPathIfExisting(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    const leftStat = fs.statSync(left, { bigint: true });
    const rightStat = fs.statSync(right, { bigint: true });
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function configuredLiveTargets(): { dataDirs: string[]; dbPaths: string[] } {
  const dataDirs = ['/app/data'];
  if (process.env.DATA_DIR) dataDirs.push(process.env.DATA_DIR);
  const dbPaths = ['/app/data/curator.db'];
  if (process.env.DB_PATH && process.env.DB_PATH !== ':memory:') dbPaths.push(process.env.DB_PATH);
  return { dataDirs, dbPaths };
}

/** Snapshot-only is enforceable: the filename must advertise itself as a snapshot. */
export function assertSnapshotPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const basename = path.basename(resolved).toLowerCase();
  if (!basename.includes('snapshot')) {
    throw new Error('refusing database path: the filename must contain "snapshot"');
  }
  if (basename === 'curator.db') {
    throw new Error('refusing an obvious live/default DATA_DIR database path');
  }
  const liveTargets = configuredLiveTargets();
  for (const dataDir of liveTargets.dataDirs) {
    if (isPathInside(canonicalPathIfExisting(dataDir), canonicalPathIfExisting(resolved))) {
      throw new Error('refusing a database inside a live/default DATA_DIR');
    }
  }
  for (const dbPath of liveTargets.dbPaths) {
    if (canonicalPathIfExisting(dbPath) === canonicalPathIfExisting(resolved) || sameFile(dbPath, resolved)) {
      throw new Error('refusing the configured/default live DB_PATH');
    }
  }
  return resolved;
}

function assertSnapshotFileIdentity(snapshotPath: string): string {
  const realSnapshotPath = fs.realpathSync(snapshotPath);
  assertSnapshotPath(realSnapshotPath);
  const snapshotStat = fs.statSync(realSnapshotPath);
  // A consistent snapshot must be a distinct copy, never a hard-link alias
  // whose inode remains the live database's inode.
  if (snapshotStat.nlink > 1) throw new Error('refusing a hard-linked database; create a distinct snapshot copy');
  const liveTargets = configuredLiveTargets();
  for (const dbPath of liveTargets.dbPaths) {
    if (sameFile(realSnapshotPath, dbPath)) throw new Error('refusing a database alias of the configured/default live DB_PATH');
  }
  return realSnapshotPath;
}

function parseGenres(value: unknown, bookId: unknown): unknown {
  if (value === null) return [];
  if (typeof value !== 'string') throw new Error(`invalid genres column in snapshot for book ${String(bookId)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`invalid genres JSON in snapshot for book ${String(bookId)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((genre) => typeof genre !== 'string')) {
    throw new Error(`genres must decode to string[] in snapshot for book ${String(bookId)}`);
  }
  return parsed;
}

function parseOptionalJson(value: unknown, field: string, bookId: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error(`invalid ${field} column in snapshot for book ${String(bookId)}`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`invalid ${field} JSON in snapshot for book ${String(bookId)}`);
  }
}

function mapBook(row: SqlRow): unknown {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    series: row.series,
    seriesSequence: row.series_sequence,
    durationSeconds: row.duration_seconds,
    publishedYear: row.published_year,
    genres: parseGenres(row.genres, row.id),
    description: row.description,
    coverPath: row.cover_path,
    absAddedAt: row.abs_added_at,
    lastSyncedAt: row.last_synced_at,
    libraryId: row.library_id,
    itemPath: row.item_path,
    asin: row.asin,
    isbn: row.isbn,
    absUpdatedAt: row.abs_updated_at,
    lastSeenSyncId: row.last_seen_sync_id,
    syncStatus: row.sync_status,
    deletedAt: row.deleted_at,
    normalizedTitle: row.normalized_title,
    titleParse: parseOptionalJson(row.title_parse, 'title_parse', row.id),
    titleMetaSource: parseOptionalJson(row.title_meta_source, 'title_meta_source', row.id),
  };
}

function mapTag(row: SqlRow): unknown {
  if (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
    throw new Error(`invalid tag confidence in snapshot for book ${String(row.book_id)}: expected a finite number in [0,1]`);
  }
  return {
    id: row.id,
    bookId: row.book_id,
    tag: row.tag,
    category: row.category,
    confidence: row.confidence,
    taggedAt: row.tagged_at,
    source: row.source,
  };
}

function decodeVector(value: unknown, bookId: string): Float32Array {
  if (!Buffer.isBuffer(value)) throw new Error(`embedding vector for ${bookId} is not a SQLite BLOB`);
  if (value.byteLength === 0 || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`embedding vector for ${bookId} has an invalid byte length`);
  }
  const vector = new Float32Array(value.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = value.readFloatLE(index * 4);
    if (!Number.isFinite(vector[index])) throw new Error(`embedding vector for ${bookId} contains a non-finite value`);
  }
  return vector;
}

/** Opens SQLite with readonly + fileMustExist and never constructs CuratorDb (which migrates). */
export function loadReadonlyAcceptanceSnapshot(inputPath: string, model: string): AcceptanceSnapshot {
  if (!model.trim()) throw new Error('embedding model must be configured');
  const snapshotPath = assertSnapshotPath(inputPath);
  // Re-check the real target so a snapshot-named symlink cannot point at a
  // live/default database and bypass the filename/path guard above.
  const realSnapshotPath = assertSnapshotFileIdentity(snapshotPath);
  const db = openReadonlyAcceptanceDatabase(realSnapshotPath);
  try {
    const columns = (db.prepare('PRAGMA table_info(books)').all() as Array<{ name: string }>).map((column) => column.name);
    if (columns.length === 0) throw new Error('snapshot is missing the books table');
    if (columns.includes('sync_status')) {
      const invalidStatus = db.prepare(
        "SELECT id, sync_status FROM books WHERE sync_status IS NULL OR sync_status NOT IN ('active', 'deleted') ORDER BY id LIMIT 1"
      ).get() as SqlRow | undefined;
      if (invalidStatus) {
        throw new Error(
          `invalid sync_status in snapshot for book ${String(invalidStatus.id)}: expected "active" or "deleted"`
        );
      }
    }
    const activePredicate = columns.includes('sync_status') ? " WHERE sync_status = 'active'" : '';
    const activeJoinPredicate = columns.includes('sync_status') ? " WHERE b.sync_status = 'active'" : '';
    const books = (db.prepare(`SELECT * FROM books${activePredicate} ORDER BY id`).all() as SqlRow[]).map(mapBook);
    const orphanTags = db.prepare('SELECT COUNT(*) AS count FROM book_tags bt LEFT JOIN books b ON b.id = bt.book_id WHERE b.id IS NULL').get() as { count: number };
    if (orphanTags.count > 0) throw new Error(`snapshot contains ${orphanTags.count} orphan tag row(s)`);
    const tags = (
      db.prepare(`SELECT bt.* FROM book_tags bt JOIN books b ON b.id = bt.book_id${activeJoinPredicate} ORDER BY bt.book_id, bt.id`).all() as SqlRow[]
    ).map(mapTag);
    const orphanEmbeddings = db.prepare('SELECT COUNT(*) AS count FROM book_embeddings e LEFT JOIN books b ON b.id = e.book_id WHERE b.id IS NULL').get() as { count: number };
    if (orphanEmbeddings.count > 0) throw new Error(`snapshot contains ${orphanEmbeddings.count} orphan embedding row(s)`);
    const embeddings = (
      db.prepare(
        `SELECT e.book_id, e.model, e.card_hash, e.vector
         FROM book_embeddings e JOIN books b ON b.id = e.book_id
         WHERE e.model = ?${columns.includes('sync_status') ? " AND b.sync_status = 'active'" : ''}
         ORDER BY e.book_id`
      ).all(model) as SqlRow[]
    )
      .map((row) => ({
        bookId: row.book_id,
        model: row.model,
        cardHash: row.card_hash,
        vector: decodeVector(row.vector, typeof row.book_id === 'string' ? row.book_id : '<invalid>'),
      }));
    return validateAcceptanceSnapshot({ books, tags, embeddings });
  } finally {
    db.close();
  }
}

export type AcceptanceDatabaseFactory = (dbPath: string, options: Database.Options) => Database.Database;

export function openReadonlyAcceptanceDatabase(
  dbPath: string,
  factory: AcceptanceDatabaseFactory = (target, options) => new Database(target, options)
): Database.Database {
  return factory(dbPath, { readonly: true, fileMustExist: true });
}
