/**
 * Data-layer tests for the two column additions that back R2 (description
 * backfill) and R3 (narrator persistence) — see
 * `docs/enrichment-sources-review.md` §3. This file owns exactly the schema
 * mechanics: column round-tripping, `upsertBook`'s ABS-mirror invariant for
 * `description`/`narrator`, and migration of a pre-existing database. It
 * does NOT test description-cleaning or backfill-pass logic — those belong
 * to the R2/R3 feature slices, not the data layer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from './db.js';
import { resolveDescription } from './enrichment/descriptionText.js';
import { composeBookCard } from './retrieval/bookCard.js';
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

function tempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, 'lib.db');
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('narrator column', () => {
  it('round-trips a multi-narrator list through upsertBook / getBook', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Full Cast', narrator: ['Jefferson Mays', 'Marc Thompson'] });

    expect(db.getBook('b1')?.narrator).toEqual(['Jefferson Mays', 'Marc Thompson']);
  });

  it('stores no narrator as NULL, not "[]", and decodes back to null', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'No Narrator Given' });

    expect(db.getBook('b1')?.narrator).toBeNull();
  });

  it('an empty narrator array is also stored as NULL', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Empty Array', narrator: [] });

    expect(db.getBook('b1')?.narrator).toBeNull();
  });

  it('a re-sync (upsertBook) updates the narrator column when ABS reports one, but never clears it when ABS reports none', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book', narrator: ['R.C. Bray'] });
    expect(db.getBook('b1')?.narrator).toEqual(['R.C. Bray']);

    // ABS now reports a different narrator on the next sync.
    addBook(db, { id: 'b1', title: 'Book', narrator: ['Someone Else'] });
    expect(db.getBook('b1')?.narrator).toEqual(['Someone Else']);

    // ABS reports no narrator at all on this sync (narratorName absent). Unlike
    // `genres`, this must NOT clear the column — see the regression test below
    // for why: a sync with nothing to report must never be able to erase a
    // value another writer (setNarrator) put there.
    addBook(db, { id: 'b1', title: 'Book' });
    expect(db.getBook('b1')?.narrator).toEqual(['Someone Else']);
  });

  it('setNarrator survives the very next ABS sync when ABS reports no narratorName', () => {
    // Regression test for a review finding: upsertBook used to unconditionally
    // overwrite `narrator` (writing NULL whenever the incoming book had none),
    // which silently erased anything setNarrator (the R3 cache-only Audnexus
    // pass) had written on the very next sync, and also misclassified the book
    // as "updated" on every subsequent sync forever after.
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' }); // ABS has no narratorName for this book.
    db.setNarrator('b1', ['R.C. Bray']);
    expect(db.getBook('b1')?.narrator).toEqual(['R.C. Bray']);

    // A routine sync runs again; ABS still has no narratorName.
    const outcome = db.upsertBook({
      id: 'b1', title: 'Book', author: null, series: null, seriesSequence: null,
      durationSeconds: null, publishedYear: null, genres: [], description: null,
      coverPath: null, absAddedAt: null, lastSyncedAt: Date.now(),
    });

    expect(db.getBook('b1')?.narrator).toEqual(['R.C. Bray']);
    expect(outcome).toBe('unchanged');
  });

  it('ABS reporting a narrator still overwrites one that setNarrator previously wrote', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });
    db.setNarrator('b1', ['Audnexus Guess']);
    expect(db.getBook('b1')?.narrator).toEqual(['Audnexus Guess']);

    addBook(db, { id: 'b1', title: 'Book', narrator: ['ABS Reported Narrator'] });
    expect(db.getBook('b1')?.narrator).toEqual(['ABS Reported Narrator']);
  });

  it('a narrator change is classified as "updated", not "unchanged"', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book', narrator: ['A'] });
    const outcome = db.upsertBook({
      id: 'b1', title: 'Book', author: null, series: null, seriesSequence: null,
      durationSeconds: null, publishedYear: null, genres: [], description: null,
      coverPath: null, absAddedAt: null, lastSyncedAt: Date.now(), narrator: ['B'],
    });
    expect(outcome).toBe('updated');
  });

  it('setNarrator updates the column independent of a full book upsert', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });

    db.setNarrator('b1', ['Audnexus Narrator One', 'Audnexus Narrator Two']);
    expect(db.getBook('b1')?.narrator).toEqual(['Audnexus Narrator One', 'Audnexus Narrator Two']);

    db.setNarrator('b1', null);
    expect(db.getBook('b1')?.narrator).toBeNull();
  });

  it('a malformed stored narrator value decodes to null instead of throwing', () => {
    const dbPath = tempDbPath('audioshelf-db-narrator-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET narrator = ? WHERE id = ?').run('{not valid json', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    expect(() => db.getBook('b1')).not.toThrow();
    expect(db.getBook('b1')?.narrator).toBeNull();
  });

  it('a non-array JSON value in narrator decodes to null instead of throwing', () => {
    const dbPath = tempDbPath('audioshelf-db-narrator-nonarray-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET narrator = ? WHERE id = ?').run('{"not":"an array"}', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    expect(db.getBook('b1')?.narrator).toBeNull();
  });

  it('a stored empty-array narrator decodes to null, never "[]" (known-empty is not a state either writer produces)', () => {
    const dbPath = tempDbPath('audioshelf-db-narrator-emptyarray-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET narrator = ? WHERE id = ?').run('[]', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    expect(db.getBook('b1')?.narrator).toBeNull();
  });

  it('a stored array with no usable string entries decodes to null, not an empty array', () => {
    const dbPath = tempDbPath('audioshelf-db-narrator-nostrings-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET narrator = ? WHERE id = ?').run('[5, null, false]', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    expect(db.getBook('b1')?.narrator).toBeNull();
  });
});

describe('description_enriched / description_source columns', () => {
  it('setEnrichedDescription writes both columns together and getBook decodes them verbatim', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book', description: 'The ABS blurb.' });

    db.setEnrichedDescription('b1', { text: 'Harvested description text.', source: 'audnexus' });

    const book = db.getBook('b1')!;
    expect(book.descriptionEnriched).toBe('Harvested description text.');
    expect(book.descriptionSource).toBe('audnexus');
    // books.description (the ABS mirror) is completely untouched.
    expect(book.description).toBe('The ABS blurb.');
  });

  it('setEnrichedDescription(null) clears both columns together', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });
    db.setEnrichedDescription('b1', { text: 'Some text', source: 'googlebooks' });
    expect(db.getBook('b1')?.descriptionEnriched).toBe('Some text');

    db.setEnrichedDescription('b1', null);
    const book = db.getBook('b1')!;
    expect(book.descriptionEnriched).toBeNull();
    expect(book.descriptionSource).toBeNull();
  });

  it('a book with neither column ever set decodes both to null', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });
    const book = db.getBook('b1')!;
    expect(book.descriptionEnriched).toBeNull();
    expect(book.descriptionSource).toBeNull();
  });

  it('an unrecognized stored description_source decodes to null instead of being cast through unchecked', () => {
    // `DescriptionSource` is 'audnexus' | 'wikidata' | 'googlebooks' |
    // 'openlibrary' — deliberately not 'abs' (see core/types.ts). A row
    // written by a future or rolled-back build with an unknown value must
    // not be trusted verbatim, the same way genres/titleParse/
    // titleMetaSource/narrator are validated on decode.
    const dbPath = tempDbPath('audioshelf-db-descsource-invalid-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET description_enriched = ?, description_source = ? WHERE id = ?')
      .run('Some text', 'abs', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    expect(db.getBook('b1')?.descriptionSource).toBeNull();
  });

  it('round-trips the two R5/R8-widened members ("wikidata", "openlibrary") through setEnrichedDescription/getBook exactly like the original two', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });

    db.setEnrichedDescription('b1', { text: 'An encyclopedia-style intro.', source: 'wikidata' });
    expect(db.getBook('b1')?.descriptionEnriched).toBe('An encyclopedia-style intro.');
    expect(db.getBook('b1')?.descriptionSource).toBe('wikidata');

    db.setEnrichedDescription('b1', { text: 'A work-level synopsis.', source: 'openlibrary' });
    expect(db.getBook('b1')?.descriptionEnriched).toBe('A work-level synopsis.');
    expect(db.getBook('b1')?.descriptionSource).toBe('openlibrary');

    db.setEnrichedDescription('b1', null);
    expect(db.getBook('b1')?.descriptionEnriched).toBeNull();
    expect(db.getBook('b1')?.descriptionSource).toBeNull();
  });

  it('rollback decode: a source value only a NEWER build recognises (standing in for a widened member this build lacks) decodes to null, but descriptionEnriched survives verbatim', () => {
    // 'fandom' stands in for a future DescriptionSource member — R4 (Fandom)
    // is explicitly out of scope for this wave, so it is a safe stand-in
    // that is guaranteed not to collide with a real member here.
    const dbPath = tempDbPath('audioshelf-db-descsource-forward-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const harvested = 'A harvested encyclopedia intro naming Bill Denbrough and Derry.';
    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET description_enriched = ?, description_source = ? WHERE id = ?')
      .run(harvested, 'fandom', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBeNull();
    expect(book.descriptionEnriched).toBe(harvested);
  });

  it('rollback decode is retrieval-neutral: resolveDescription still returns the harvested text (with source null), and the composed card is byte-identical to a book whose source decoded normally', () => {
    const dbPath = tempDbPath('audioshelf-db-descsource-forward-neutral-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const harvested = 'A harvested encyclopedia intro naming Bill Denbrough and Derry.';
    const raw = new Database(dbPath);
    raw.prepare('UPDATE books SET description_enriched = ?, description_source = ? WHERE id = ?')
      .run(harvested, 'fandom', 'b1');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    const rolledBack = db.getBook('b1')!;

    const resolved = resolveDescription(rolledBack);
    expect(resolved).toEqual({ text: harvested, source: null });

    // A book with the exact same descriptionEnriched but a source this
    // build DOES recognise composes to the same card text/hash — losing
    // provenance costs no card text and triggers no re-embed.
    const recognised: Book = { ...rolledBack, descriptionSource: 'wikidata' };
    expect(composeBookCard(rolledBack, [], []).hash).toBe(composeBookCard(recognised, [], []).hash);
  });

  it('re-syncing the same book (upsertBook) never writes description_enriched or description_source', () => {
    // The regression this schema split exists to prevent: a sync must not be
    // able to clobber harvested text, in either direction.
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });
    db.setEnrichedDescription('b1', { text: 'Harvested', source: 'googlebooks' });

    // Re-sync from ABS with an unrelated field change.
    addBook(db, { id: 'b1', title: 'Book', description: 'Now ABS has a description' });

    const book = db.getBook('b1')!;
    expect(book.description).toBe('Now ABS has a description');
    expect(book.descriptionEnriched).toBe('Harvested');
    expect(book.descriptionSource).toBe('googlebooks');
  });

  it('books.description stays byte-identical across a sync even when it starts and ends null', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book' });
    db.setEnrichedDescription('b1', { text: 'Harvested', source: 'audnexus' });

    const outcome = db.upsertBook({
      id: 'b1', title: 'Book', author: null, series: null, seriesSequence: null,
      durationSeconds: null, publishedYear: null, genres: [], description: null,
      coverPath: null, absAddedAt: null, lastSyncedAt: Date.now(),
    });

    expect(outcome).toBe('unchanged');
    const book = db.getBook('b1')!;
    expect(book.description).toBeNull();
    expect(book.descriptionEnriched).toBe('Harvested');
  });
});

describe('R2/R3 columns migrate onto a pre-existing books table', () => {
  it('adds description_enriched, description_source, and narrator to a DB predating this migration, leaving the existing row unharmed', () => {
    const dbPath = tempDbPath('audioshelf-db-r2r3-migrate-');

    // Old-shape DB: the full column set as it existed immediately before
    // this migration (every prior additive column present), none of the
    // three new ones.
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
        last_synced_at INTEGER NOT NULL,
        library_id TEXT, item_path TEXT, asin TEXT, isbn TEXT,
        abs_updated_at INTEGER, last_seen_sync_id TEXT,
        sync_status TEXT NOT NULL DEFAULT 'active', deleted_at INTEGER,
        normalized_title TEXT, title_parse TEXT, title_meta_source TEXT
      );
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    `);
    raw
      .prepare(
        `INSERT INTO books (id, title, author, series, series_sequence, duration_seconds,
           published_year, genres, description, cover_path, abs_added_at, last_synced_at, sync_status)
         VALUES ('b1','Old Book','Old Author',NULL,NULL,NULL,NULL,'["fantasy"]','Old description',NULL,NULL,1000,'active')`
      )
      .run();
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);

    expect(() => db.getBook('b1')).not.toThrow();
    const book = db.getBook('b1')!;
    // Pre-existing row survives, completely unharmed.
    expect(book.title).toBe('Old Book');
    expect(book.author).toBe('Old Author');
    expect(book.genres).toEqual(['fantasy']);
    expect(book.description).toBe('Old description');
    // New columns exist and read back as null on a row that predates them.
    expect(book.descriptionEnriched).toBeNull();
    expect(book.descriptionSource).toBeNull();
    expect(book.narrator).toBeNull();

    // The migrated columns are writable going forward.
    db.setEnrichedDescription('b1', { text: 'New harvested text', source: 'audnexus' });
    db.setNarrator('b1', ['Someone']);
    const after = db.getBook('b1')!;
    expect(after.descriptionEnriched).toBe('New harvested text');
    expect(after.narrator).toEqual(['Someone']);
  });

  it('is idempotent: reopening an already-migrated database does not throw or duplicate columns', () => {
    const dbPath = tempDbPath('audioshelf-db-r2r3-reopen-');
    const first = new CuratorDb(dbPath);
    addBook(first, { id: 'b1', title: 'Book' });
    first.close();

    const second = new CuratorDb(dbPath);
    databases.push(second);
    expect(() => second.getBook('b1')).not.toThrow();

    const raw = new Database(dbPath);
    const columns = (raw.prepare('PRAGMA table_info(books)').all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();
    expect(columns.filter((c) => c === 'narrator')).toHaveLength(1);
    expect(columns.filter((c) => c === 'description_enriched')).toHaveLength(1);
    expect(columns.filter((c) => c === 'description_source')).toHaveLength(1);
  });
});

describe('fresh vs migrated schema agreement', () => {
  it('a freshly created database and a migrated pre-existing database end up with identical books columns', () => {
    // Fresh: CuratorDb provisions a brand-new file from MIGRATIONS + applyMigrations.
    const freshPath = tempDbPath('audioshelf-db-fresh-');
    const freshDb = new CuratorDb(freshPath);
    freshDb.close();

    // Migrated: an old-shape DB (as in the migration test above) brought
    // forward through applyMigrations.
    const migratedPath = tempDbPath('audioshelf-db-migrated-');
    const raw = new Database(migratedPath);
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
    raw.close();
    const migratedDb = new CuratorDb(migratedPath);
    migratedDb.close();

    function columnSet(dbPath: string): string[] {
      const conn = new Database(dbPath);
      const cols = (conn.prepare('PRAGMA table_info(books)').all() as Array<{ name: string; type: string }>)
        .map((c) => `${c.name}:${c.type}`)
        .sort();
      conn.close();
      return cols;
    }

    expect(columnSet(freshPath)).toEqual(columnSet(migratedPath));
    // And, concretely, both carry the three new columns.
    const cols = columnSet(freshPath);
    expect(cols.some((c) => c.startsWith('narrator:'))).toBe(true);
    expect(cols.some((c) => c.startsWith('description_enriched:'))).toBe(true);
    expect(cols.some((c) => c.startsWith('description_source:'))).toBe(true);
  });
});
