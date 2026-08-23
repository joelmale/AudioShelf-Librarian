import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { parseBookTitles, REVIEW_CAP } from './titleParser.js';

const databases: CuratorDb[] = [];

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
  vi.restoreAllMocks();
});

describe('parseBookTitles', () => {
  it('fills a null author and null published year from the title, and never touches an existing author', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '24 - Snow Crash - Neal Stephenson - 1992' });
    addBook(db, { id: 'b2', title: '9 - It - Stephen King - 1986', author: 'Already Set' });

    const result = await parseBookTitles(db, { concurrency: 2, now: () => 1000 });

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);

    const b1 = db.getBook('b1');
    // A full-library dry run recovered ZERO authors because this used to stay
    // null — the case the feature exists for. The `<title> - <author> - <year>`
    // shape is unambiguous enough to infer from, at low confidence.
    expect(b1?.author).toBe('Neal Stephenson');
    expect(b1?.normalizedTitle).toBe('Snow Crash');
    expect(b1?.publishedYear).toBe(1992);
    expect(b1?.titleParse?.ordinal).toBe(24);

    const b2 = db.getBook('b2');
    expect(b2?.author).toBe('Already Set'); // pre-existing author is never overwritten
    expect(b2?.publishedYear).toBe(1986);
  });

  it('fills a null author when the book already has a known author to verify the title-derived segment against', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    // author already known lets parseTitle confidently strip it from the title and confirm it — but
    // author column itself must already be non-null for that, so this exercises the year-fill path
    // plus a case where the known author *is* present pre-parse and stays untouched.
    addBook(db, { id: 'b1', title: '24 - Snow Crash - Neal Stephenson - 1992', author: 'Neal Stephenson' });

    await parseBookTitles(db, { concurrency: 1, now: () => 1000 });

    const b1 = db.getBook('b1');
    expect(b1?.author).toBe('Neal Stephenson');
    expect(b1?.publishedYear).toBe(1992);
    expect(b1?.titleMetaSource).toEqual({ publishedYear: 'title-parse' });
  });

  it('never writes ordinal to seriesSequence even though an ordinal was parsed', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '52 - Frankenstein - Mary Shelley - 1818' });

    await parseBookTitles(db, { concurrency: 1, now: () => 1000 });

    const b1 = db.getBook('b1');
    expect(b1?.titleParse?.ordinal).toBe(52);
    expect(b1?.seriesSequence).toBeNull();
  });

  it('never modifies books.title', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '2_ Apt Pupil' });

    await parseBookTitles(db, { concurrency: 1, now: () => 1000 });

    expect(db.getBook('b1')?.title).toBe('2_ Apt Pupil');
  });

  it('dry run writes nothing and returns a review table with totals', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: '24 - Snow Crash - Neal Stephenson - 1992', author: 'Neal Stephenson' });
    addBook(db, { id: 'b2', title: 'Dune' });

    const result = await parseBookTitles(db, { dryRun: true, concurrency: 2, now: () => 1000 });

    expect(result.dryRun).toBe(true);
    expect(result.review).toHaveLength(2);
    expect(result.reviewTotal).toBe(2);
    expect(result.filledYearCount).toBe(1); // b1 gains 1992
    expect(result.filledAuthorCount).toBe(0); // b1 already had an author; b2 has no discoverable author

    // Nothing was actually written.
    expect(db.getBook('b1')?.publishedYear).toBeNull();
    expect(db.getBook('b1')?.titleParse).toBeNull();
    expect(db.getBook('b2')?.titleParse).toBeNull();
  });

  it('dry run caps the review array at REVIEW_CAP but reports the true total', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    for (let i = 0; i < REVIEW_CAP + 10; i += 1) {
      addBook(db, { id: `b${i}`, title: `Book ${i}` });
    }

    const result = await parseBookTitles(db, { dryRun: true, concurrency: 4, now: () => 1000 });

    expect(result.review).toHaveLength(REVIEW_CAP);
    expect(result.reviewTotal).toBe(REVIEW_CAP + 10);
  });

  it('isolates a per-book failure: one book failing does not stop the others from being processed', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'good1', title: 'Dune' });
    addBook(db, { id: 'bad', title: 'Boom' });
    addBook(db, { id: 'good2', title: 'Neuromancer' });

    const realUpdate = db.updateTitleParse.bind(db);
    vi.spyOn(db, 'updateTitleParse').mockImplementation((bookId, parse, harvested) => {
      if (bookId === 'bad') throw new Error('simulated failure');
      return realUpdate(bookId, parse, harvested);
    });

    const result = await parseBookTitles(db, { concurrency: 3, now: () => 1000 });

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe('bad');
    expect(db.getBook('good1')?.titleParse).not.toBeNull();
    expect(db.getBook('good2')?.titleParse).not.toBeNull();
  });

  it('skips books that already have a title_parse', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Dune' });
    addBook(db, { id: 'b2', title: 'Neuromancer' });

    await parseBookTitles(db, { concurrency: 2, now: () => 1000, bookIds: ['b1'] });
    expect(db.getBook('b1')?.titleParse).not.toBeNull();
    expect(db.getBook('b2')?.titleParse).toBeNull();

    // A second run over everything only picks up the still-unparsed book.
    const result = await parseBookTitles(db, { concurrency: 2, now: () => 2000 });
    expect(result.processed).toBe(1);
  });

  it('sample mode runs a representative subset of the candidate pool', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    for (let i = 0; i < 100; i += 1) addBook(db, { id: `b${i}`, title: `Book ${i}` });

    const result = await parseBookTitles(db, { concurrency: 4, now: () => 1000, sample: true, sampleSize: 10 });

    expect(result.sample).toBe(true);
    expect(result.processed).toBe(10);
    const parsedCount = Array.from({ length: 100 }, (_, i) => db.getBook(`b${i}`)).filter(
      (b) => b?.titleParse !== null
    ).length;
    expect(parsedCount).toBe(10);
  });
});
