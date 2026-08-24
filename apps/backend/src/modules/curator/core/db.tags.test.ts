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

describe('getAverageTagTokenUsage', () => {
  it('returns null when there is no successful tag run yet', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    expect(db.getAverageTagTokenUsage()).toBeNull();
  });

  it('averages tokens per book across successful runs, weighted by processed count', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const run1 = db.startLog('tag', 1000);
    db.finishLog(
      run1,
      'success',
      { processed: 2, skipped: 0, failed: 0, errors: [], tokensUsed: { inputTokens: 4000, outputTokens: 1000 }, dryRun: false },
      1100
    );
    const run2 = db.startLog('tag', 2000);
    db.finishLog(
      run2,
      'success',
      { processed: 1, skipped: 0, failed: 0, errors: [], tokensUsed: { inputTokens: 3000, outputTokens: 800 }, dryRun: false },
      2100
    );

    // 3 books total, 7000 input tokens, 1800 output tokens across both runs.
    const avg = db.getAverageTagTokenUsage();
    expect(avg).not.toBeNull();
    expect(avg?.sampleSize).toBe(3);
    expect(avg?.inputTokensPerBook).toBeCloseTo(7000 / 3);
    expect(avg?.outputTokensPerBook).toBeCloseTo(1800 / 3);
  });

  it('skips dry runs and runs that tagged zero books', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const dryRunId = db.startLog('tag', 1000);
    db.finishLog(dryRunId, 'success', { dryRun: true, planned: 958 }, 1100);

    const emptyRunId = db.startLog('tag', 2000);
    db.finishLog(
      emptyRunId,
      'success',
      { processed: 0, skipped: 0, failed: 0, errors: [], tokensUsed: { inputTokens: 0, outputTokens: 0 }, dryRun: false },
      2100
    );

    expect(db.getAverageTagTokenUsage()).toBeNull();
  });

  it('ignores errored runs and a malformed detail blob without throwing', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    const erroredId = db.startLog('tag', 1000);
    db.finishLog(
      erroredId,
      'error',
      { processed: 5, skipped: 0, failed: 5, errors: [], tokensUsed: { inputTokens: 9000, outputTokens: 2000 }, dryRun: false },
      1100
    );

    const goodId = db.startLog('tag', 2000);
    db.finishLog(
      goodId,
      'success',
      { processed: 1, skipped: 0, failed: 0, errors: [], tokensUsed: { inputTokens: 1800, outputTokens: 300 }, dryRun: false },
      2100
    );

    expect(() => db.getAverageTagTokenUsage()).not.toThrow();
    const avg = db.getAverageTagTokenUsage();
    expect(avg?.sampleSize).toBe(1);
    expect(avg?.inputTokensPerBook).toBe(1800);
  });

  it('only considers the most recent maxRuns runs', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);

    for (let i = 0; i < 5; i += 1) {
      const id = db.startLog('tag', 1000 + i);
      db.finishLog(
        id,
        'success',
        { processed: 1, skipped: 0, failed: 0, errors: [], tokensUsed: { inputTokens: 1000, outputTokens: 100 }, dryRun: false },
        1100 + i
      );
    }

    const avg = db.getAverageTagTokenUsage(2);
    expect(avg?.sampleSize).toBe(2);
  });
});
