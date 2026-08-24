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

describe('external_metadata', () => {
  it('round-trips an upsert including payload JSON, and a second upsert overwrites status', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.upsertExternalMetadata({
      bookId: 'b1',
      provider: 'openlibrary',
      payload: { key: '/works/OL1W', person: ['Benjamin Hanscom'] },
      fetchedAt: 1000,
      status: 'ok',
    });

    let rec = db.getExternalMetadataForProvider('b1', 'openlibrary');
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe('ok');
    expect(rec?.payload).toEqual({ key: '/works/OL1W', person: ['Benjamin Hanscom'] });
    expect(rec?.fetchedAt).toBe(1000);

    // Second upsert (ok -> error) overwrites rather than duplicating the row.
    db.upsertExternalMetadata({
      bookId: 'b1',
      provider: 'openlibrary',
      payload: null,
      fetchedAt: 2000,
      status: 'error',
    });

    rec = db.getExternalMetadataForProvider('b1', 'openlibrary');
    expect(rec?.status).toBe('error');
    expect(rec?.payload).toBeNull();
    expect(rec?.fetchedAt).toBe(2000);

    const all = db.getExternalMetadata('b1');
    expect(all).toHaveLength(1);
  });

  it('getExternalMetadataForProvider returns null when no row exists', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    expect(db.getExternalMetadataForProvider('b1', 'openlibrary')).toBeNull();
  });

  it('getExternalMetadata returns multiple provider rows for the same book', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.upsertExternalMetadata({ bookId: 'b1', provider: 'audnexus', payload: { asin: 'B1' }, fetchedAt: 1, status: 'ok' });
    db.upsertExternalMetadata({ bookId: 'b1', provider: 'openlibrary', payload: null, fetchedAt: 2, status: 'not-found' });

    const rows = db.getExternalMetadata('b1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.provider).sort()).toEqual(['audnexus', 'openlibrary']);
  });

  it('a malformed stored payload decodes to payload: null instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-enrichment-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    // Create the schema, then close and corrupt one payload value directly.
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book One' });
    seed.close();
    databases.splice(databases.indexOf(seed), 1);

    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO external_metadata (book_id, provider, payload, fetched_at, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('b1', 'openlibrary', '{not valid json', 3000, 'ok');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);

    expect(() => db.getExternalMetadata('b1')).not.toThrow();
    const rec = db.getExternalMetadataForProvider('b1', 'openlibrary');
    expect(rec).not.toBeNull();
    expect(rec?.payload).toBeNull();
    expect(rec?.status).toBe('ok');
  });
});

describe('book_entities', () => {
  it('replaceBookEntities replaces rather than appends, and round-trips sources arrays', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookEntities('b1', [
      { entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Maine', kind: 'place', sources: ['openlibrary', 'wikidata'] },
    ]);

    let entities = db.getEntitiesForBook('b1');
    expect(entities).toHaveLength(2);

    // Second call replaces the whole set rather than appending to it.
    db.replaceBookEntities('b1', [{ entity: 'Derry', kind: 'place', sources: ['wikidata'] }]);

    entities = db.getEntitiesForBook('b1');
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ bookId: 'b1', entity: 'Derry', kind: 'place', sources: ['wikidata'] });
  });

  it('getEntitiesForBook orders by kind then entity', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookEntities('b1', [
      { entity: 'Zack', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Anna', kind: 'person', sources: ['openlibrary'] },
      { entity: '1980s', kind: 'time', sources: ['wikidata'] },
      { entity: 'Bangor', kind: 'place', sources: ['wikidata'] },
    ]);

    const entities = db.getEntitiesForBook('b1');
    expect(entities.map((e) => `${e.kind}:${e.entity}`)).toEqual([
      'person:Anna',
      'person:Zack',
      'place:Bangor',
      'time:1980s',
    ]);
  });

  it('replaceBookEntities on one book does not affect another book\'s entities', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    db.replaceBookEntities('b1', [{ entity: 'Alice', kind: 'person', sources: ['openlibrary'] }]);
    db.replaceBookEntities('b2', [{ entity: 'Bob', kind: 'person', sources: ['openlibrary'] }]);

    db.replaceBookEntities('b1', []);

    expect(db.getEntitiesForBook('b1')).toHaveLength(0);
    expect(db.getEntitiesForBook('b2')).toHaveLength(1);
  });

  it('replaceBookEntities defaults notable to true when the field is omitted', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookEntities('b1', [{ entity: 'Alice', kind: 'person', sources: ['openlibrary'] }]);

    expect(db.getEntitiesForBook('b1')).toEqual([
      { bookId: 'b1', entity: 'Alice', kind: 'person', sources: ['openlibrary'], notable: true },
    ]);
  });

  it('replaceBookEntities persists an explicit notable: false, and getEntitiesForBook(notableOnly) excludes it', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    db.replaceBookEntities('b1', [
      { entity: 'Alice', kind: 'person', sources: ['openlibrary'], notable: true },
      { entity: 'God', kind: 'person', sources: ['openlibrary'], notable: false },
    ]);

    const all = db.getEntitiesForBook('b1');
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.entity === 'God')?.notable).toBe(false);

    const notableOnly = db.getEntitiesForBook('b1', { notableOnly: true });
    expect(notableOnly).toHaveLength(1);
    expect(notableOnly[0]).toMatchObject({ entity: 'Alice', notable: true });
  });

  it('opening a pre-migration db (no notable column) is idempotent and existing rows default to notable: true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshelf-db-entities-migration-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lib.db');

    // Build a legacy book_entities table by hand — no `notable` column — then
    // let CuratorDb's constructor (applyMigrations) add it on open. `books`
    // matches the full current schema (it isn't the column under test here);
    // only `book_entities` is deliberately pre-migration.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE books (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, series TEXT, series_sequence REAL,
        duration_seconds INTEGER, published_year INTEGER, genres TEXT, description TEXT, cover_path TEXT,
        abs_added_at INTEGER, last_synced_at INTEGER NOT NULL
      );
      CREATE TABLE book_entities (
        book_id TEXT NOT NULL, entity TEXT NOT NULL, kind TEXT NOT NULL, sources TEXT NOT NULL,
        PRIMARY KEY (book_id, entity, kind)
      );
    `);
    raw.prepare('INSERT INTO books (id, title, last_synced_at) VALUES (?, ?, ?)').run('b1', 'Book One', 1);
    raw
      .prepare('INSERT INTO book_entities (book_id, entity, kind, sources) VALUES (?, ?, ?, ?)')
      .run('b1', 'Alice', 'person', '["openlibrary"]');
    raw.close();

    const db = new CuratorDb(dbPath);
    databases.push(db);
    expect(db.getEntitiesForBook('b1')).toEqual([
      { bookId: 'b1', entity: 'Alice', kind: 'person', sources: ['openlibrary'], notable: true },
    ]);
    db.close();
    databases.splice(databases.indexOf(db), 1);

    // Reopening an already-migrated db must not throw (no duplicate ALTER TABLE).
    const reopened = new CuratorDb(dbPath);
    databases.push(reopened);
    expect(reopened.getEntitiesForBook('b1')).toEqual([
      { bookId: 'b1', entity: 'Alice', kind: 'person', sources: ['openlibrary'], notable: true },
    ]);
  });
});

describe('getEntityBookCounts / countActiveBooks', () => {
  it('counts distinct active books per normalized (trimmed, lowercased) entity, scoped by kind when given', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    addBook(db, { id: 'b3', title: 'Book Three' });

    db.replaceBookEntities('b1', [
      { entity: 'God', kind: 'person', sources: ['openlibrary'] },
      { entity: 'Derry', kind: 'place', sources: ['openlibrary'] },
    ]);
    db.replaceBookEntities('b2', [{ entity: '  god  ', kind: 'person', sources: ['openlibrary'] }]); // same entity, different case/whitespace
    db.replaceBookEntities('b3', [{ entity: 'Benjamin Hanscom', kind: 'person', sources: ['openlibrary'] }]);

    const allCounts = db.getEntityBookCounts();
    expect(allCounts.get('god')).toBe(2);
    expect(allCounts.get('derry')).toBe(1);
    expect(allCounts.get('benjamin hanscom')).toBe(1);

    const placeCounts = db.getEntityBookCounts('place');
    expect(placeCounts.get('derry')).toBe(1);
    expect(placeCounts.has('god')).toBe(false);
  });

  it('excludes a tombstoned (deleted) book from both getEntityBookCounts and countActiveBooks', () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    db.replaceBookEntities('b1', [{ entity: 'God', kind: 'person', sources: ['openlibrary'] }]);
    db.replaceBookEntities('b2', [{ entity: 'God', kind: 'person', sources: ['openlibrary'] }]);

    expect(db.countActiveBooks()).toBe(2);
    expect(db.getEntityBookCounts().get('god')).toBe(2);

    db.tombstoneBook('b2');

    expect(db.countActiveBooks()).toBe(1);
    expect(db.getEntityBookCounts().get('god')).toBe(1);
  });
});

describe('getEnrichmentCandidates', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = 1_000_000 * DAY_MS; // arbitrary fixed "now" far from epoch
  const okTtlMs = 90 * DAY_MS;
  const notFoundTtlMs = 30 * DAY_MS;

  function setup(): CuratorDb {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'fresh-ok', title: 'Fresh OK' });
    addBook(db, { id: 'stale-ok', title: 'Stale OK' });
    addBook(db, { id: 'fresh-not-found', title: 'Fresh Not Found' });
    addBook(db, { id: 'stale-not-found', title: 'Stale Not Found' });
    addBook(db, { id: 'errored', title: 'Errored' });
    addBook(db, { id: 'no-row', title: 'No Row' });
    return db;
  }

  it('excludes a fresh ok row and includes a stale ok row', () => {
    const db = setup();
    db.upsertExternalMetadata({ bookId: 'fresh-ok', provider: 'openlibrary', payload: {}, fetchedAt: now - 1 * DAY_MS, status: 'ok' });
    db.upsertExternalMetadata({ bookId: 'stale-ok', provider: 'openlibrary', payload: {}, fetchedAt: now - 91 * DAY_MS, status: 'ok' });

    const ids = db.getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now }).map((b) => b.id);
    expect(ids).not.toContain('fresh-ok');
    expect(ids).toContain('stale-ok');
  });

  it('refresh ignores both TTLs and returns every active book', () => {
    // After the titles improve, every cached 'not-found' is stale in a way no
    // timestamp expresses — a normal run reported 0 of 958 candidates.
    const db = setup();
    db.upsertExternalMetadata({ bookId: 'fresh-ok', provider: 'openlibrary', payload: {}, fetchedAt: now - 1 * DAY_MS, status: 'ok' });
    db.upsertExternalMetadata({ bookId: 'fresh-not-found', provider: 'openlibrary', payload: null, fetchedAt: now - 1 * DAY_MS, status: 'not-found' });

    const normal = db.getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now }).map((b) => b.id);
    expect(normal).not.toContain('fresh-ok');
    expect(normal).not.toContain('fresh-not-found');

    const refreshed = db
      .getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now, refresh: true })
      .map((b) => b.id);
    expect(refreshed).toContain('fresh-ok');
    expect(refreshed).toContain('fresh-not-found');
    expect(refreshed).toHaveLength(6);
  });

  it('refresh still honours a bookIds restriction and excludes deleted books', () => {
    const db = setup();
    db.tombstoneBook('no-row');
    const ids = db
      .getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now, refresh: true, bookIds: ['fresh-ok', 'no-row'] })
      .map((b) => b.id);
    expect(ids).toEqual(['fresh-ok']);
  });

  it('excludes a not-found row within TTL and includes one past it', () => {
    const db = setup();
    db.upsertExternalMetadata({ bookId: 'fresh-not-found', provider: 'openlibrary', payload: null, fetchedAt: now - 1 * DAY_MS, status: 'not-found' });
    db.upsertExternalMetadata({ bookId: 'stale-not-found', provider: 'openlibrary', payload: null, fetchedAt: now - 31 * DAY_MS, status: 'not-found' });

    const ids = db.getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now }).map((b) => b.id);
    expect(ids).not.toContain('fresh-not-found');
    expect(ids).toContain('stale-not-found');
  });

  it('always includes an errored row regardless of freshness', () => {
    const db = setup();
    db.upsertExternalMetadata({ bookId: 'errored', provider: 'openlibrary', payload: null, fetchedAt: now, status: 'error' });

    const ids = db.getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now }).map((b) => b.id);
    expect(ids).toContain('errored');
  });

  it('includes a book with no cached row at all', () => {
    const db = setup();

    const ids = db.getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now }).map((b) => b.id);
    expect(ids).toContain('no-row');
  });

  it('restricts to the given bookIds when provided', () => {
    const db = setup();

    const ids = db
      .getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now, bookIds: ['no-row', 'errored'] })
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(['errored', 'no-row']);
  });

  it('is scoped per-provider: a fresh row for a different provider does not exclude the book', () => {
    const db = setup();
    db.upsertExternalMetadata({ bookId: 'fresh-ok', provider: 'audnexus', payload: {}, fetchedAt: now, status: 'ok' });

    const ids = db.getEnrichmentCandidates('openlibrary', { okTtlMs, notFoundTtlMs, now }).map((b) => b.id);
    expect(ids).toContain('fresh-ok');
  });
});
