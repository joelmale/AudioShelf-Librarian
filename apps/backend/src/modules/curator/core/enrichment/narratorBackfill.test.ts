import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { OperationCancelledError } from '../errors.js';
import type { OperationController } from '../operations.js';
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

  it('never overwrites an existing (ABS-sourced) narrator, even with a cleaner Audnexus list available', async () => {
    const db = makeDb();
    // Simulates ABS's naive comma-split on "Bray, R.C." producing two bogus
    // entries. Audnexus's clean, single-entry list is available in the
    // cache but must NOT replace it — see the module docblock's "Fill
    // absences only" section: ABS stays authoritative, and overwriting here
    // would only be reverted by the next sync (upsertBook's COALESCE),
    // producing a permanent oscillation.
    db.upsertBook(baseBook({ narrator: ['Bray', 'R.C.'] }));
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
    expect(result.changedBookIds).toEqual([]);
    expect(db.getBook('b00')?.narrator).toEqual(['Bray', 'R.C.']);
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

  it('ignores an error-status row even when it carries a real, usable payload', async () => {
    // Distinct from the not-found case above (which relies on `payload:
    // null`, so it would pass even if the `row.status !== 'ok'` check were
    // removed). This directly exercises the status guard: the payload here
    // has real, extractable narrators, so only the status check stands
    // between it and a write.
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'From Error Row' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'error',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.rowsWithNarrators).toBe(0);
    expect(result.booksChanged).toBe(0);
    expect(db.getBook('b00')?.narrator).toBeNull();
  });

  it('filters a non-string narrators[].name instead of throwing, keeping the valid entries', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: {
        raw: { narrators: [{ name: 123 }, { name: 'Real Name' }] },
        entities: [],
        subjects: [],
      },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, {});

    expect(result.failed).toBe(0);
    expect(result.booksChanged).toBe(1);
    expect(db.getBook('b00')?.narrator).toEqual(['Real Name']);
  });

  it('collapses internal whitespace in a narrator name, not just leading/trailing', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: '  Spaced   Name  ' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    await backfillNarratorsFromCache(db, {});

    // Must match what bookCard.ts's own collapseWhitespace renders on the
    // card for the same name, or the stored value and the card diverge.
    expect(db.getBook('b00')?.narrator).toEqual(['Spaced Name']);
  });

  it('is a no-op when the stored narrator already matches the cached Audnexus list', async () => {
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

  it('never overwrites an existing narrator even when Audnexus lists the same names in a different order', async () => {
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

    expect(result.booksChanged).toBe(0);
    // The pre-existing (billing-order-correct) list survives untouched —
    // "fill absences only" applies regardless of whether the two sources
    // merely disagree on order or on content.
    expect(db.getBook('b00')?.narrator).toEqual(['Adam Narrator', 'Zoe Narrator']);
  });

  it('is idempotent: a second run over a book this pass already filled makes no further change', async () => {
    const db = makeDb();
    db.upsertBook(baseBook());
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const first = await backfillNarratorsFromCache(db, {});
    expect(first.booksChanged).toBe(1);
    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);

    // Re-running against the now-filled column (as a sync-chained pass
    // would) must not thrash — see the module docblock's "Fill absences
    // only" section on the oscillation this prevents.
    const second = await backfillNarratorsFromCache(db, {});
    expect(second.booksChanged).toBe(0);
    expect(second.changedBookIds).toEqual([]);
    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);
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

  it('does not count a bookId with a cached row but no matching books row as changed', async () => {
    const db = makeDb();
    // No upsertBook call for 'ghost' — simulates a book removed from the
    // library after its external_metadata row was cached (or a caller
    // passing a stale id). external_metadata has no FK on book_id, so this
    // is a legal, if unusual, database state.
    db.upsertExternalMetadata({
      bookId: 'ghost',
      provider: 'audnexus',
      payload: { raw: audnexusRaw([{ name: 'R.C. Bray' }]), entities: [], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });

    const result = await backfillNarratorsFromCache(db, { bookIds: ['ghost'] });

    expect(result.rowsWithNarrators).toBe(1);
    expect(result.booksChanged).toBe(0);
    expect(result.changedBookIds).toEqual([]);
    expect(result.examples).toEqual([]);
    expect(db.getBook('ghost')).toBeUndefined();
  });

  it('stops after cancellation, leaving the already-processed book intact and skipping the rest', async () => {
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

    // Minimal fake controller satisfying the surface this module actually
    // calls (checkpoint/setProgress/markCompleted/markCancelled/id — see
    // core/operations.ts), mirroring enricher.test.ts's cancellation test.
    let checkpointCalls = 0;
    const fakeController = {
      id: 'op-fake',
      checkpoint: vi.fn(async () => {
        checkpointCalls += 1;
        if (checkpointCalls > 1) throw new OperationCancelledError('op-fake');
      }),
      setProgress: vi.fn(),
      markCompleted: vi.fn(),
      markCancelled: vi.fn(),
    };

    const result = await backfillNarratorsFromCache(db, {
      controller: fakeController as unknown as OperationController,
    });

    expect(result.cancelled).toBe(true);
    expect(result.booksScanned).toBe(1);
    expect(result.booksChanged).toBe(1);
    expect(db.getBook('b00')?.narrator).toEqual(['R.C. Bray']);
    // Cancelled before b01 was ever examined.
    expect(db.getBook('b01')?.narrator).toBeNull();
    expect(fakeController.markCancelled).toHaveBeenCalledWith(result);
    expect(fakeController.markCompleted).not.toHaveBeenCalled();
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
