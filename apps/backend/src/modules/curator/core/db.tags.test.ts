import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import type { Book } from './types.js';

const databases: CuratorDb[] = [];
const tempDirs: string[] = [];

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title'>): void {
  db.upsertBook({
    ...input,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('book_tags source column', () => {
  it('round-trips a source on a fresh DB via replaceBookTags/getTagsForBook', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookTags(
      'b1',
      [{ tag: 'epic-fantasy', category: 'genre', confidence: 0.9, source: 'vocab' }],
      Date.now()
    );

    const tags = db.getTagsForBook('b1');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.source).toBe('vocab');
  });

  it('adds the source column on migration and backfills existing rows as llm-open', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-tags-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'legacy.db');

    // Build a DB with the OLD book_tags shape (no `source` column) plus a row,
    // simulating a database that predates this migration.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE books (
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
      CREATE TABLE book_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id TEXT NOT NULL REFERENCES books(id),
        tag TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL NOT NULL,
        tagged_at INTEGER NOT NULL,
        UNIQUE(book_id, tag)
      );
    `);
    raw
      .prepare(
        `INSERT INTO books (id, title, last_synced_at) VALUES (?, ?, ?)`
      )
      .run('legacy-book', 'Legacy Book', Date.now());
    raw
      .prepare(
        `INSERT INTO book_tags (book_id, tag, category, confidence, tagged_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('legacy-book', 'noir', 'mood', 0.7, Date.now());
    raw.close();

    // Opening with CuratorDb must run the additive migration idempotently.
    const db = new CuratorDb(dbPath);
    databases.push(db);

    const tags = db.getTagsForBook('legacy-book');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe('noir');
    expect(tags[0]?.source).toBe('llm-open');

    // Re-opening (idempotent re-migration) must not throw or duplicate the column.
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = new CuratorDb(dbPath);
    databases.push(reopened);
    expect(reopened.getTagsForBook('legacy-book')[0]?.source).toBe('llm-open');
  });

  it('round-trips an external:<slug> style source', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b2', title: 'Book Two' });

    db.replaceBookTags(
      'b2',
      [{ tag: 'gothic', category: 'mood', confidence: 0.6, source: 'external:openlibrary' }],
      Date.now()
    );

    const tags = db.getTagsForBook('b2');
    expect(tags[0]?.source).toBe('external:openlibrary');
  });
});
