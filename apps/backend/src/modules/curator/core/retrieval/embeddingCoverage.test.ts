import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { composeEmbeddingCard, reportEmbeddingCoverage } from './embedder.js';

const MODEL = 'test-model';
const databases: CuratorDb[] = [];

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

function addBook(db: CuratorDb, id: string, title = `Title ${id}`): void {
  db.upsertBook({
    id,
    title,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 1_000,
  } as Book);
}

/** Embed `id` with the card it currently has, under `model`. */
function embed(db: CuratorDb, id: string, model = MODEL, cardHash?: string): void {
  const card = composeEmbeddingCard(db, db.getBook(id)!);
  db.upsertBookEmbedding({
    bookId: id,
    model,
    cardHash: cardHash ?? card.hash,
    vector: Float32Array.from([1, 0]),
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('reportEmbeddingCoverage', () => {
  it('separates the three non-fresh states the counts alone cannot distinguish', () => {
    // A stalled backfill and a card_hash invalidation produce similar totals
    // but need opposite responses, which is the whole reason this exists.
    const db = makeDb();
    addBook(db, 'fresh');
    addBook(db, 'never');
    addBook(db, 'oldmodel');
    addBook(db, 'changed');
    embed(db, 'fresh');
    embed(db, 'oldmodel', 'some-other-model');
    embed(db, 'changed', MODEL, 'a-hash-from-a-card-this-book-no-longer-has');

    const report = reportEmbeddingCoverage(db, MODEL, { limit: 100 });

    expect(report.total).toBe(4);
    expect(report.fresh).toBe(1);
    expect(report.neverEmbedded).toBe(1);
    expect(report.stale).toBe(2);
    const byState = Object.fromEntries(report.books.map((b) => [b.bookId, b.state]));
    expect(byState).toEqual({
      fresh: 'fresh',
      never: 'never-embedded',
      oldmodel: 'model-changed',
      changed: 'card-changed',
    });
  });

  it('lists non-fresh books first so the missing ones are what you see', () => {
    const db = makeDb();
    addBook(db, 'a-fresh', 'AAA Fresh');
    addBook(db, 'z-never', 'ZZZ Never');
    embed(db, 'a-fresh');

    const report = reportEmbeddingCoverage(db, MODEL, { limit: 100 });

    expect(report.books.map((b) => b.bookId)).toEqual(['z-never', 'a-fresh']);
  });

  it('filters to one state while still counting the whole library', () => {
    const db = makeDb();
    addBook(db, 'fresh');
    addBook(db, 'never1');
    addBook(db, 'never2');
    embed(db, 'fresh');

    const report = reportEmbeddingCoverage(db, MODEL, { state: 'never-embedded', limit: 100 });

    expect(report.books.map((b) => b.bookId).sort()).toEqual(['never1', 'never2']);
    // Counts describe the library, not the filtered slice.
    expect(report.fresh).toBe(1);
    expect(report.total).toBe(3);
  });

  it('reports how many matched before the limit truncated the listing', () => {
    // No silent truncation: a caller must be able to tell a short list from
    // a complete one.
    const db = makeDb();
    for (let i = 0; i < 5; i += 1) addBook(db, `b${i}`);

    const report = reportEmbeddingCoverage(db, MODEL, { limit: 2 });

    expect(report.books).toHaveLength(2);
    expect(report.matched).toBe(5);
  });

  it('counts a book embedded under a different model as stale, never as fresh', () => {
    const db = makeDb();
    addBook(db, 'b1');
    embed(db, 'b1', 'a-different-model');

    const report = reportEmbeddingCoverage(db, MODEL);

    expect(report.fresh).toBe(0);
    expect(report.stale).toBe(1);
  });
});
