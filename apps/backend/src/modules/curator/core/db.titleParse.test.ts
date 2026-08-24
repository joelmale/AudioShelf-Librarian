import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import { parseTitle } from './enrichment/titleParse.js';
import type { Book } from './types.js';

const databases: CuratorDb[] = [];
const tempDirs: string[] = [];

function addBook(db: CuratorDb, input: Partial<Book> & Pick<Book, 'id' | 'title'>): void {
  db.upsertBook({
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
    ...input,
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('updateTitleParse / getBooksNeedingTitleParse', () => {
  it('round-trips normalized_title, title_parse, and title_meta_source', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '24 - Snow Crash - Neal Stephenson - 1992' });

    const parse = parseTitle('24 - Snow Crash - Neal Stephenson - 1992', 'Neal Stephenson');
    db.updateTitleParse('b1', parse, { author: parse.author, publishedYear: parse.year });

    const book = db.getBook('b1');
    expect(book?.normalizedTitle).toBe('Snow Crash');
    expect(book?.titleParse).toEqual(parse);
    expect(book?.titleMetaSource).toEqual({ author: 'title-parse', publishedYear: 'title-parse' });
    // The harvested fields actually landed on the books columns too.
    expect(book?.author).toBe('Neal Stephenson');
    expect(book?.publishedYear).toBe(1992);
  });

  it('fills a null author but never overwrites an existing one, even if the caller passes one in error', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Some Title', author: 'Original Author' });

    db.updateTitleParse(
      'b1',
      parseTitle('Some Title', null),
      { author: 'Parsed Author', publishedYear: 1999 }
    );

    const book = db.getBook('b1');
    // COALESCE at the SQL layer protects the existing value regardless of caller correctness.
    expect(book?.author).toBe('Original Author');
    expect(book?.publishedYear).toBe(1999);
  });

  it('never touches books.title', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '24 - Snow Crash - Neal Stephenson - 1992' });

    db.updateTitleParse('b1', parseTitle('24 - Snow Crash - Neal Stephenson - 1992', null), {});

    const book = db.getBook('b1');
    expect(book?.title).toBe('24 - Snow Crash - Neal Stephenson - 1992');
  });

  it('writes title_meta_source only for the fields actually passed in harvested', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Dune' });

    db.updateTitleParse('b1', parseTitle('Dune', null), { author: 'Frank Herbert' });

    const book = db.getBook('b1');
    expect(book?.titleMetaSource).toEqual({ author: 'title-parse' });
  });

  it('leaves title_meta_source null when nothing was harvested', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Dune' });

    db.updateTitleParse('b1', parseTitle('Dune', null), {});

    const book = db.getBook('b1');
    expect(book?.titleMetaSource).toBeNull();
  });

  it('a malformed stored title_parse decodes to titleParse: null instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-titleparse-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book One' });
    seed.close();
    databases.splice(databases.indexOf(seed), 1);

    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET title_parse = ? WHERE id = ?').run('{not valid json', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);

    expect(() => db.getBook('b1')).not.toThrow();
    expect(db.getBook('b1')?.titleParse).toBeNull();
  });

  it('getBooksNeedingTitleParse returns only active books with no title_parse yet', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'needs-parse', title: 'Needs Parse' });
    addBook(db, { id: 'already-parsed', title: 'Already Parsed' });
    db.updateTitleParse('already-parsed', parseTitle('Already Parsed', null), {});
    addBook(db, { id: 'deleted-book', title: 'Deleted Book' });
    db.tombstoneBook('deleted-book');

    const ids = db.getBooksNeedingTitleParse().map((b) => b.id);
    expect(ids).toEqual(['needs-parse']);
  });

  it('reparse includes books already carrying a parse, but still excludes deleted ones', () => {
    // Without this, a run after a parser improvement is a silent no-op — and
    // that is exactly the state a library is in once it has been parsed once.
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'needs-parse', title: 'Needs Parse' });
    addBook(db, { id: 'already-parsed', title: 'Already Parsed' });
    db.updateTitleParse('already-parsed', parseTitle('Already Parsed', null), {});
    addBook(db, { id: 'deleted-book', title: 'Deleted Book' });
    db.tombstoneBook('deleted-book');

    const ids = db.getBooksNeedingTitleParse({ reparse: true }).map((b) => b.id).sort();
    expect(ids).toEqual(['already-parsed', 'needs-parse']);
  });

  it('reparse still honours a bookIds restriction', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'One' });
    addBook(db, { id: 'b2', title: 'Two' });
    db.updateTitleParse('b1', parseTitle('One', null), {});
    db.updateTitleParse('b2', parseTitle('Two', null), {});

    const ids = db.getBooksNeedingTitleParse({ reparse: true, bookIds: ['b2'] }).map((b) => b.id);
    expect(ids).toEqual(['b2']);
  });

  it('re-parsing never overwrites an author the catalogue already has', () => {
    // The safety property that makes reparse safe to expose at all.
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '55 - The Diamond Age - Neal Stephenson - 1995', author: 'Someone Else' });
    db.updateTitleParse('b1', parseTitle('55 - The Diamond Age - Neal Stephenson - 1995', null), {
      author: 'Neal Stephenson',
    });
    expect(db.getBook('b1')?.author).toBe('Someone Else');
  });

  it('getBooksNeedingTitleParse restricts to the given bookIds', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const ids = db.getBooksNeedingTitleParse({ bookIds: ['b1'] }).map((b) => b.id);
    expect(ids).toEqual(['b1']);
  });
});

describe('title-parse columns migrate onto an old-shape books table', () => {
  it('adds normalized_title / title_parse / title_meta_source (and prior additive columns) to a pre-existing DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-titleparse-migrate-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    // Old-shape DB: only the original base `books` table, matching the
    // project's very first schema, none of the additive columns present.
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
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    `);
    raw
      .prepare(
        `INSERT INTO books (id, title, author, series, series_sequence, duration_seconds,
           published_year, genres, description, cover_path, abs_added_at, last_synced_at)
         VALUES ('b1','Old Book',NULL,NULL,NULL,NULL,NULL,'[]',NULL,NULL,NULL,1000)`
      )
      .run();
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);

    // The migrated DB is queryable via the new accessors without error, and
    // the pre-existing row survives untouched.
    expect(() => db.getBooksNeedingTitleParse()).not.toThrow();
    const needing = db.getBooksNeedingTitleParse().map((b) => b.id);
    expect(needing).toEqual(['b1']);

    db.updateTitleParse('b1', parseTitle('Old Book', null), {});
    const book = db.getBook('b1');
    expect(book?.title).toBe('Old Book');
    expect(book?.normalizedTitle).toBe('Old Book');
    expect(book?.titleParse).not.toBeNull();
  });
});
