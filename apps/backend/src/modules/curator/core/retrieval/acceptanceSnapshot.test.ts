import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertSnapshotPath, loadReadonlyAcceptanceSnapshot, openReadonlyAcceptanceDatabase } from './acceptanceSnapshot.js';

const sandboxes: string[] = [];
const originalDataDir = process.env.DATA_DIR;
const originalDbPath = process.env.DB_PATH;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-acceptance-'));
  sandboxes.push(directory);
  return directory;
}

function createSnapshot(dbPath: string, vector: unknown = Buffer.from(Float32Array.from([1, 0]).buffer)): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, series TEXT, series_sequence REAL,
      duration_seconds INTEGER, published_year INTEGER, genres TEXT, description TEXT,
      cover_path TEXT, abs_added_at INTEGER, last_synced_at INTEGER NOT NULL
    );
    CREATE TABLE book_tags (
      id INTEGER PRIMARY KEY, book_id TEXT, tag TEXT, category TEXT, confidence REAL,
      tagged_at INTEGER, source TEXT
    );
    CREATE TABLE book_embeddings (book_id TEXT PRIMARY KEY, model TEXT, card_hash TEXT, vector BLOB);
    INSERT INTO books VALUES ('b1', 'Fixture One', NULL, NULL, NULL, 3600, 2020, '[]', NULL, NULL, NULL, 1);
    INSERT INTO book_tags VALUES (1, 'b1', 'cozy', 'mood', 1, 1, 'vocab');
  `);
  db.prepare('INSERT INTO book_embeddings VALUES (?, ?, ?, ?)').run('b1', 'fixture-model', 'hash', vector);
  db.close();
}

function addSyncStatusColumn(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec("ALTER TABLE books ADD COLUMN sync_status TEXT; UPDATE books SET sync_status = 'active'");
  return db;
}

describe('readonly acceptance snapshot loader', () => {
  it('opens SQLite with both readonly and fileMustExist enabled', () => {
    let receivedPath: string | undefined;
    let receivedOptions: Database.Options | undefined;
    const fakeHandle = {} as Database.Database;
    const result = openReadonlyAcceptanceDatabase('fixture-snapshot.db', (dbPath, options) => {
      receivedPath = dbPath;
      receivedOptions = options;
      return fakeHandle;
    });
    expect(result).toBe(fakeHandle);
    expect(receivedPath).toBe('fixture-snapshot.db');
    expect(receivedOptions).toEqual({ readonly: true, fileMustExist: true });
  });
  it('rejects paths that are not explicitly named as snapshots and obvious live DATA_DIR paths', () => {
    expect(() => assertSnapshotPath('curator.db')).toThrow('filename must contain "snapshot"');
    expect(() => assertSnapshotPath('/app/data/library-snapshot.db')).toThrow('live/default DATA_DIR');
  });

  it('reads a fixture database without migrating or writing it', () => {
    const dbPath = path.join(sandbox(), 'fixture-snapshot.db');
    createSnapshot(dbPath);
    const before = fs.statSync(dbPath).mtimeMs;

    const snapshot = loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model');

    expect(snapshot.books.map((book) => book.title)).toEqual(['Fixture One']);
    expect([...snapshot.embeddings[0]!.vector]).toEqual([1, 0]);
    expect(fs.statSync(dbPath).mtimeMs).toBe(before);
    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all()).toEqual([
      'book_embeddings',
      'book_tags',
      'books',
    ]);
    verify.close();
  });

  it.each([
    ['NULL', null],
    ['unknown', 'archived'],
  ])('rejects a %s sync status before active-only extraction', (_label, status) => {
    const dbPath = path.join(sandbox(), 'invalid-status-snapshot.db');
    createSnapshot(dbPath);
    const db = addSyncStatusColumn(dbPath);
    db.prepare(
      `INSERT INTO books (
        id, title, author, series, series_sequence, duration_seconds, published_year, genres,
        description, cover_path, abs_added_at, last_synced_at, sync_status
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    ).run('b2', 'Invalid Status', 1800, 2021, '[]', 2, status);
    db.close();

    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('invalid sync_status');
  });

  it('rejects a non-text BLOB sync status before active-only extraction', () => {
    const dbPath = path.join(sandbox(), 'blob-status-snapshot.db');
    createSnapshot(dbPath);
    const db = addSyncStatusColumn(dbPath);
    db.exec("UPDATE books SET sync_status = X'0102'");
    db.close();

    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('invalid sync_status');
  });

  it('accepts deleted rows while excluding their books, tags, and embeddings', () => {
    const dbPath = path.join(sandbox(), 'deleted-status-snapshot.db');
    createSnapshot(dbPath);
    const db = addSyncStatusColumn(dbPath);
    db.prepare(
      `INSERT INTO books (
        id, title, author, series, series_sequence, duration_seconds, published_year, genres,
        description, cover_path, abs_added_at, last_synced_at, sync_status
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, ?, 'deleted')`
    ).run('b2', 'Deleted Book', 1800, 2021, '[]', 2);
    db.prepare('INSERT INTO book_tags VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'b2', 'dark', 'mood', 1, 2, 'vocab');
    db.prepare('INSERT INTO book_embeddings VALUES (?, ?, ?, ?)').run(
      'b2',
      'fixture-model',
      'deleted-hash',
      Buffer.from(Float32Array.from([0, 1]).buffer)
    );
    db.close();

    const snapshot = loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model');

    expect(snapshot.books.map((book) => book.id)).toEqual(['b1']);
    expect(snapshot.tags.map((tag) => tag.bookId)).toEqual(['b1']);
    expect(snapshot.embeddings.map((embedding) => embedding.bookId)).toEqual(['b1']);
  });

  it('rejects malformed fixture snapshots and an unconfigured model', () => {
    const directory = sandbox();
    const dbPath = path.join(directory, 'empty-snapshot.db');
    new Database(dbPath).close();
    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, '')).toThrow('embedding model must be configured');
    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('missing the books table');
    // The finally path closes SQLite even when validation fails; a rename is
    // observably blocked by an open handle on Windows.
    const movedPath = path.join(directory, 'moved-snapshot.db');
    fs.renameSync(dbPath, movedPath);
    expect(fs.existsSync(movedPath)).toBe(true);
  });

  it('rejects configured DATA_DIR and DB_PATH targets after canonicalization', () => {
    const directory = sandbox();
    const dataDir = path.join(directory, 'data');
    fs.mkdirSync(dataDir);
    const insideDataDir = path.join(dataDir, 'live-snapshot.db');
    createSnapshot(insideDataDir);
    process.env.DATA_DIR = dataDir;
    expect(() => loadReadonlyAcceptanceSnapshot(insideDataDir, 'fixture-model')).toThrow('live/default DATA_DIR');

    delete process.env.DATA_DIR;
    process.env.DB_PATH = insideDataDir;
    expect(() => loadReadonlyAcceptanceSnapshot(insideDataDir, 'fixture-model')).toThrow('live DB_PATH');
  });

  it('rejects a DATA_DIR reached through a directory symlink or junction alias', () => {
    const directory = sandbox();
    const realDataDir = path.join(directory, 'real-data');
    const aliasDataDir = path.join(directory, 'aliased-data');
    fs.mkdirSync(realDataDir);
    const livePath = path.join(realDataDir, 'library-snapshot.db');
    createSnapshot(livePath);
    try {
      fs.symlinkSync(realDataDir, aliasDataDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    process.env.DATA_DIR = realDataDir;
    expect(() => loadReadonlyAcceptanceSnapshot(path.join(aliasDataDir, 'library-snapshot.db'), 'fixture-model')).toThrow(
      'live/default DATA_DIR'
    );
  });

  it('rejects hard-link aliases of a database', () => {
    const directory = sandbox();
    const livePath = path.join(directory, 'live.db');
    const aliasPath = path.join(directory, 'library-snapshot.db');
    createSnapshot(livePath);
    fs.linkSync(livePath, aliasPath);
    process.env.DB_PATH = livePath;
    expect(() => loadReadonlyAcceptanceSnapshot(aliasPath, 'fixture-model')).toThrow('live DB_PATH');
    delete process.env.DB_PATH;
    expect(() => loadReadonlyAcceptanceSnapshot(aliasPath, 'fixture-model')).toThrow('hard-linked database');
  });

  it('rejects symlink aliases where the host permits creating them', () => {
    const directory = sandbox();
    const livePath = path.join(directory, 'live.db');
    const aliasPath = path.join(directory, 'library-snapshot.db');
    createSnapshot(livePath);
    try {
      fs.symlinkSync(livePath, aliasPath, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    process.env.DB_PATH = livePath;
    expect(() => loadReadonlyAcceptanceSnapshot(aliasPath, 'fixture-model')).toThrow();
  });

  it.each([
    ['non-BLOB', 'not-a-blob', 'not a SQLite BLOB'],
    ['bad byte length', Buffer.from([1, 2, 3]), 'invalid byte length'],
    ['non-finite BLOB', (() => { const value = Buffer.alloc(4); value.writeFloatLE(Number.NaN); return value; })(), 'non-finite value'],
  ])('rejects a %s vector and closes the database', (_label, vector, message) => {
    const directory = sandbox();
    const dbPath = path.join(directory, 'invalid-vector-snapshot.db');
    createSnapshot(dbPath, vector);
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow(message);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it.each([
    ['text', 'not-a-number'],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['below zero', -0.01],
    ['above one', 1.01],
  ])('rejects malformed %s tag confidence and closes the database', (_label, confidence) => {
    const directory = sandbox();
    const dbPath = path.join(directory, 'invalid-confidence-snapshot.db');
    createSnapshot(dbPath);
    const db = new Database(dbPath);
    db.prepare('UPDATE book_tags SET confidence = ?').run(confidence);
    db.close();
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('invalid tag confidence');
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it.each([
    ['BLOB book title', "UPDATE books SET title = X'0102'"],
    ['non-finite book duration', 'UPDATE books SET duration_seconds = 1e999'],
    ['non-integer sync timestamp', 'UPDATE books SET last_synced_at = 1.5'],
    ['malformed genres JSON', "UPDATE books SET genres = '{'"],
    ['non-array genres JSON', "UPDATE books SET genres = '{}'"],
    ['non-string genres entry', "UPDATE books SET genres = '[\"valid\",1]'"],
    ['invalid tag primary key', 'UPDATE book_tags SET id = -1'],
    ['BLOB tag text', "UPDATE book_tags SET tag = X'0102'"],
    ['invalid tag category', "UPDATE book_tags SET category = 'unknown'"],
    ['invalid tag source', "UPDATE book_tags SET source = 'external:'"],
    ['non-integer tagged timestamp', 'UPDATE book_tags SET tagged_at = 1.5'],
    ['empty embedding card hash', "UPDATE book_embeddings SET card_hash = ''"],
  ])('rejects malformed SQLite row: %s', (_label, sql) => {
    const dbPath = path.join(sandbox(), 'malformed-row-snapshot.db');
    createSnapshot(dbPath);
    const db = new Database(dbPath);
    db.exec(sql);
    db.close();
    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow();
  });

  it('rejects duplicate SQLite evidence rows', () => {
    const dbPath = path.join(sandbox(), 'duplicate-evidence-snapshot.db');
    createSnapshot(dbPath);
    const db = new Database(dbPath);
    db.prepare('INSERT INTO book_tags VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'b1', 'cozy', 'mood', 1, 2, 'vocab');
    db.close();
    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('duplicate tag');
  });

  it('rejects orphan SQLite evidence rows', () => {
    const dbPath = path.join(sandbox(), 'orphan-evidence-snapshot.db');
    createSnapshot(dbPath);
    const db = new Database(dbPath);
    db.prepare('INSERT INTO book_tags VALUES (?, ?, ?, ?, ?, ?, ?)').run(3, 'orphan', 'valid', 'mood', 1, 2, 'vocab');
    db.close();
    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('orphan tag');
  });

  it('rejects orphan SQLite embedding rows', () => {
    const dbPath = path.join(sandbox(), 'orphan-embedding-snapshot.db');
    createSnapshot(dbPath);
    const db = new Database(dbPath);
    db.prepare('UPDATE book_embeddings SET book_id = ?').run('orphan');
    db.close();
    expect(() => loadReadonlyAcceptanceSnapshot(dbPath, 'fixture-model')).toThrow('orphan embedding');
  });
});
