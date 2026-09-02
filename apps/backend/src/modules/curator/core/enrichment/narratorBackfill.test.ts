import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { backfillNarratorsFromCache } from './narratorBackfill.js';

const databases: CuratorDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

function baseBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b00',
    title: 'Book Zero',
    author: 'An Author',
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 0,
    ...overrides,
  };
}

function audnexusRaw(narrators: Array<{ name?: string }>): unknown {
  return { narrators };
}

describe('backfillNarratorsFromCache', () => {
  it('writes narrators from a cached audnexus row onto a book with none', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, { now: () => 5_000 });

    expect(result.booksChanged).toBe(1);
    expect(result.changedBookIds).toEqual(['b00']);
    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);
  });

  it('stores a full-cast list as a list, preserving Audnexus order (not sorted)', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: {
        raw: audnexusRaw([{ name: 'Zoe Narrator' }, { name: 'Adam Narrator' }]),
        entities: [],
        subjects: [],
      },
      fetchedAt: 1_000,
      status: 'ok',
    });

    await backfillNarratorsFromCache(db, {});

    // Billing order from the payload is preserved verbatim, not re-sorted
    // alphabetically the way tags/entities are elsewhere in this codebase.
    expect(db.getBook('b00')?.narrator).toEqual(['Zoe Narrator', 'Adam Narrator']);
  });

  it('overwrites an existing (ABS-sourced) narrator with the cleaner Audnexus list', async () => {
    const db = makeDb();
    // Simulates ABS's naive comma-split on "Bray, R.C." producing two bogus entries.
    db.upsertBook(baseBook({ narrator: ['Bray', 'R.C.'] }));
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.booksChanged).toBe(1);
    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);
  });

  it('never clears an existing narrator when the cached Audnexus row has none', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ narrator: ['Existing Narrator'] }));
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.booksChanged).toBe(0);
    expect(db.getBook('b00')?.narrator).toEqual(['Existing Narrator']);
  });

  it('never clears an existing narrator when narrators[] entries have blank/missing names', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ narrator: ['Existing Narrator'] }));
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: '' }, { name: undefined }, {}]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.booksChanged).toBe(0);
    expect(db.getBook('b00')?.narrator).toEqual(['Existing Narrator']);
  });

  it('leaves a book untouched when it has no cached audnexus row at all', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ narrator: ['Existing Narrator'] }));

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.booksScanned).toBe(1);
    expect(result.rowsWithNarrators).toBe(0);
    expect(result.booksChanged).toBe(0);
    expect(db.getBook('b00')?.narrator).toEqual(['Existing Narrator']);
  });

  it('ignores not-found and error audnexus rows, which carry no payload to extract from', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({ bookId: 'b00', provider: 'audnexus', payload: null, fetchedAt: 1_000, status: 'not-found' });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.rowsWithNarrators).toBe(0);
    expect(result.booksChanged).toBe(0);
    expect(db.getBook('b00')?.narrator).toBeNull();
  });

  it('is a no-op when the extracted list exactly matches what is already stored', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ narrator: ['R.C. Bray'] }));
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.rowsWithNarrators).toBe(1);
    expect(result.booksChanged).toBe(0);
  });

  it('treats a reordering of the same names as a real change (order is meaningful)', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ narrator: ['Adam Narrator', 'Zoe Narrator'] }));
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: {
        raw: audnexusRaw([{ name: 'Zoe Narrator' }, { name: 'Adam Narrator' }]),
        entities: [],
        subjects: [],
      },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.booksChanged).toBe(1);
    expect(db.getBook('b00')?.narrator).toEqual(['Zoe Narrator', 'Adam Narrator']);
  });

  it('dedupes exact-duplicate names case-insensitively, same as audnexus.ts#extractSubjects', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: {
        raw: audnexusRaw([{ name: 'R.C. Bray' }, { name: 'r.c. bray' }]),
        entities: [],
        subjects: [],
      },
      fetchedAt: 1_000,
      status: 'ok',
    });

    await backfillNarratorsFromCache(db, {});

    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);
  });

  it('makes no writes on a dry run but still reports what would change', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, { dryRun: true });

    expect(result.booksChanged).toBe(1);
    expect(result.examples[0]).toMatchObject({ bookId: 'b00', before: null, after: ['R.C. Bray'] });
    expect(db.getBook('b00')?.narrator).toBeNull();
  });

  it('never advances fetched_at on the cached external_metadata row — it only reads it', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    await backfillNarratorsFromCache(db, { now: () => 9_999_999 });

    expect(db.getExternalMetadataForProvider('b00', 'audnexus')?.fetchedAt).toBe(1_000);
  });

  it('never fetches — the signature has no fetchImpl and nothing calls out', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });
    const globalFetch = vi.spyOn(globalThis, 'fetch');

    await backfillNarratorsFromCache(db, {});

    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('honours bookIds and leaves other books untouched', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ id: 'b00' }));
    db.upsertBook(baseBook({ id: 'b01' }));
    for (const id of ['b00', 'b01']) {
      db.upsertExternalMetadata({
        bookId: id,
        provider: 'audnexus',
        payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
        fetchedAt: 1_000,
        status: 'ok',
      });
    }

    const result = await backfillNarratorsFromCache(db, { bookIds: ['b00'] });

    expect(result.booksScanned).toBe(1);
    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);
    expect(db.getBook('b01')?.narrator).toBeNull();
  });

  it('isolates a book whose lookup throws and keeps going', async () => {
    const db = makeDb();
    db.upsertBook(baseBook({ id: 'b00' }));
    db.upsertBook(baseBook({ id: 'b01' }));
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });
    db.upsertExternalMetadata({
      bookId: 'b01',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'Another Narrator' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const original = db.getExternalMetadataForProvider.bind(db);
    const spy = vi
      .spyOn(db, 'getExternalMetadataForProvider')
      .mockImplementation((bookId: string, provider: string) => {
        if (bookId === 'b00') throw new Error('boom');
        return original(bookId, provider);
      });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([{ id: 'b00', code: expect.any(String), message: expect.stringContaining('boom') }]);
    expect(result.booksScanned).toBe(2);
    expect(result.booksChanged).toBe(1);
    expect(db.getBook('b01')?.narrator).toEqual(['Another Narrator']);

    spy.mockRestore();
  });
});
