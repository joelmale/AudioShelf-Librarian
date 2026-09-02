import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import type { Book } from '../types.js';
import { backfillDescriptions } from './descriptionBackfill.js';
import { MAX_HARVESTED_DESCRIPTION_CHARS, MIN_HARVESTED_DESCRIPTION_CHARS } from './descriptionText.js';
import type { EnrichmentPayload, EnrichmentProvider } from './types.js';

const databases: CuratorDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

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

/** Cache an 'ok' external_metadata row whose `raw` is exactly `{ description }`
 *  — enough for the stub providers below to extract from. */
function cacheDescription(db: CuratorDb, bookId: string, provider: string, description: string | undefined): void {
  const payload: EnrichmentPayload = { raw: { description }, entities: [], subjects: [] };
  db.upsertExternalMetadata({ bookId, provider, payload, fetchedAt: 1_000, status: 'ok' });
}

function cacheStatus(db: CuratorDb, bookId: string, provider: string, status: 'not-found' | 'error'): void {
  db.upsertExternalMetadata({ bookId, provider, payload: null, fetchedAt: 1_000, status });
}

/** Minimal stub providers named exactly like the real ones, so
 *  `DESCRIPTION_SOURCE_PRECEDENCE` (['audnexus', 'googlebooks']) picks them
 *  up. `extractDescription` reads `raw.description` verbatim, matching both
 *  real providers' contract (uncleaned text out). */
function stubProvider(name: 'audnexus' | 'googlebooks'): EnrichmentProvider {
  return {
    name,
    lookup: async () => null,
    extractDescription(raw: unknown) {
      const description = (raw as { description?: unknown } | null)?.description;
      return typeof description === 'string' ? description : null;
    },
  };
}

/** A provider with the description field present but no `extractDescription`
 *  hook implemented — stands in for openlibrary/wikidata/hardcover. */
function noHookProvider(name: string): EnrichmentProvider {
  return { name, lookup: async () => null };
}

const PROVIDERS = [stubProvider('audnexus'), stubProvider('googlebooks')];

const ELIGIBLE_AUDNEXUS = 'An audiobook-native synopsis long enough to clear the eighty character floor easily.';
const ELIGIBLE_GOOGLEBOOKS = 'A print-edition synopsis, also comfortably past the eighty character minimum length.';

describe('backfillDescriptions', () => {
  it('prefers audnexus over googlebooks when both have eligible cached descriptions (fixed precedence, not length)', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b1', 'googlebooks', 'X'.repeat(900));

    await backfillDescriptions(db, PROVIDERS);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBe('audnexus');
    expect(book.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);
  });

  it('falls back to googlebooks when the audnexus row is "error" or "not-found"', async () => {
    for (const status of ['error', 'not-found'] as const) {
      const db = makeDb();
      addBook(db, { id: 'b1', title: 'Book' });
      cacheStatus(db, 'b1', 'audnexus', status);
      cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);

      await backfillDescriptions(db, PROVIDERS);

      const book = db.getBook('b1')!;
      expect(book.descriptionSource).toBe('googlebooks');
      expect(book.descriptionEnriched).toBe(ELIGIBLE_GOOGLEBOOKS);
    }
  });

  it('re-replaces a stored googlebooks description with audnexus the moment an audnexus row appears (recomputed, not first-write-wins)', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);
    const first = await backfillDescriptions(db, PROVIDERS);
    expect(db.getBook('b1')?.descriptionSource).toBe('googlebooks');
    expect(first.changedBookIds).toEqual(['b1']);

    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    const second = await backfillDescriptions(db, PROVIDERS);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBe('audnexus');
    expect(book.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);
    expect(second.changedBookIds).toEqual(['b1']);
  });

  it('discards a candidate below the minimum length and reports skippedTooShort; and separately, above the maximum and reports skippedTooLong', async () => {
    const shortDb = makeDb();
    addBook(shortDb, { id: 'b1', title: 'Book' });
    cacheDescription(shortDb, 'b1', 'audnexus', 'A'.repeat(62));
    const shortResult = await backfillDescriptions(shortDb, PROVIDERS);

    expect(shortResult.skippedTooShort).toBe(1);
    expect(shortResult.skippedTooLong).toBe(0);
    expect(shortDb.getBook('b1')?.descriptionEnriched).toBeNull();
    expect(shortDb.getBook('b1')?.descriptionSource).toBeNull();

    const longDb = makeDb();
    addBook(longDb, { id: 'b1', title: 'Book' });
    cacheDescription(longDb, 'b1', 'audnexus', 'A'.repeat(12_000));
    const longResult = await backfillDescriptions(longDb, PROVIDERS);

    expect(longResult.skippedTooLong).toBe(1);
    expect(longResult.skippedTooShort).toBe(0);
    expect(longDb.getBook('b1')?.descriptionEnriched).toBeNull();
  });

  it('respects the exact eligibility boundary constants', () => {
    expect(MIN_HARVESTED_DESCRIPTION_CHARS).toBe(80);
    expect(MAX_HARVESTED_DESCRIPTION_CHARS).toBe(10_000);
  });

  it('writes nothing for a book whose only cached rows are from providers with no extractDescription hook (openlibrary/wikidata/hardcover stand-ins)', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'openlibrary', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b1', 'wikidata', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b1', 'hardcover', ELIGIBLE_AUDNEXUS);

    const providersWithoutHooks = [
      ...PROVIDERS,
      noHookProvider('openlibrary'),
      noHookProvider('wikidata'),
      noHookProvider('hardcover'),
    ];
    const result = await backfillDescriptions(db, providersWithoutHooks);

    expect(db.getBook('b1')?.descriptionEnriched).toBeNull();
    expect(result.changedBookIds).toEqual([]);
  });

  it('never writes books.description — only description_enriched/description_source', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b2', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);

    await backfillDescriptions(db, PROVIDERS);

    expect(db.getBook('b1')?.description).toBeNull();
    expect(db.getBook('b2')?.description).toBeNull();
    expect(db.getBook('b1')?.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);
  });

  it('leaves description_enriched/description_source untouched (byte-identical) when the book has a non-empty ABS description, and reports no card change', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book', description: 'A perfectly good 900-char-worthy ABS blurb.' });
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);

    const result = await backfillDescriptions(db, PROVIDERS);

    // description_enriched IS populated (every active book is scanned) ...
    expect(db.getBook('b1')?.descriptionEnriched).toBe(ELIGIBLE_GOOGLEBOOKS);
    // ... but books.description is untouched and the resolved (effective)
    // description never changed, so this book contributes no card-hash churn.
    expect(db.getBook('b1')?.description).toBe('A perfectly good 900-char-worthy ABS blurb.');
    expect(result.cardTextChanged).toBe(0);
  });

  it('is idempotent: a second run over an already-backfilled library changes nothing', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    addBook(db, { id: 'b2', title: 'Book Two', description: 'ABS already has this one.' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b2', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);

    const first = await backfillDescriptions(db, PROVIDERS);
    expect(first.changedBookIds.sort()).toEqual(['b1', 'b2']);

    const second = await backfillDescriptions(db, PROVIDERS);
    expect(second.changedBookIds).toEqual([]);
    expect(second.descriptionsWritten).toBe(0);
    expect(second.descriptionsCleared).toBe(0);
    expect(db.getBook('b1')?.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);
  });

  it('clears a previously-set pair when the winning row later stops being eligible (e.g. its provider row becomes not-found)', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    await backfillDescriptions(db, PROVIDERS);
    expect(db.getBook('b1')?.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);

    // The audnexus row is re-checked and no longer resolves.
    cacheStatus(db, 'b1', 'audnexus', 'not-found');
    const result = await backfillDescriptions(db, PROVIDERS);

    expect(db.getBook('b1')?.descriptionEnriched).toBeNull();
    expect(db.getBook('b1')?.descriptionSource).toBeNull();
    expect(result.descriptionsCleared).toBe(1);
    expect(result.changedBookIds).toEqual(['b1']);
  });

  it('makes no writes on a dry run but reports cardTextChanged and groundingGateWidened accurately', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'No allowlist, no ABS' });
    addBook(db, { id: 'b2', title: 'Has a person allowlist, no ABS' });
    addBook(db, { id: 'b3', title: 'ABS already present', description: 'Already has ABS text here.' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b2', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b3', 'audnexus', ELIGIBLE_AUDNEXUS);
    db.replaceBookEntities('b2', [{ entity: 'Someone Named', kind: 'person', sources: ['openlibrary'] }]);

    const result = await backfillDescriptions(db, PROVIDERS, { dryRun: true });

    // Nothing written.
    expect(db.getBook('b1')?.descriptionEnriched).toBeNull();
    expect(db.getBook('b2')?.descriptionEnriched).toBeNull();
    expect(db.getBook('b3')?.descriptionEnriched).toBeNull();
    expect(db.getBook('b3')?.description).toBe('Already has ABS text here.');

    expect(result.dryRun).toBe(true);
    expect(result.changedBookIds.sort()).toEqual(['b1', 'b2', 'b3']);
    // b1 and b2 go from no effective description to having one; b3's ABS text
    // already resolves, so its card is unaffected despite the pair changing.
    expect(result.cardTextChanged).toBe(2);
    // Of those two, only b1 has no person allowlist.
    expect(result.groundingGateWidened).toBe(1);
    expect(result.examples.length).toBeGreaterThan(0);
  });

  it('restricts the run to `bookIds` when given, leaving other books untouched', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b2', 'audnexus', ELIGIBLE_AUDNEXUS);

    const result = await backfillDescriptions(db, PROVIDERS, { bookIds: ['b1'] });

    expect(result.booksScanned).toBe(1);
    expect(db.getBook('b1')?.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);
    expect(db.getBook('b2')?.descriptionEnriched).toBeNull();
  });

  it('isolates a failing book and keeps going', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b2', 'audnexus', ELIGIBLE_AUDNEXUS);

    let calls = 0;
    const flaky: EnrichmentProvider = {
      name: 'audnexus',
      lookup: async () => null,
      extractDescription(raw: unknown) {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return (raw as { description?: string }).description ?? null;
      },
    };

    const result = await backfillDescriptions(db, [flaky, stubProvider('googlebooks')]);

    expect(result.failed).toBe(1);
    expect(result.booksScanned).toBe(2);
    expect(result.changedBookIds.length).toBe(1);
  });

  it('never fetches — the signature has no fetchImpl and nothing calls out', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    const globalFetch = vi.spyOn(globalThis, 'fetch');

    await backfillDescriptions(db, PROVIDERS);

    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('never advances fetched_at on the cached rows it reads', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);

    await backfillDescriptions(db, PROVIDERS, { now: () => 9_999_999 });

    expect(db.getExternalMetadataForProvider('b1', 'audnexus')?.fetchedAt).toBe(1_000);
  });

  it('never mutates the cached raw payload', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);

    await backfillDescriptions(db, PROVIDERS);

    expect(db.getExternalMetadataForProvider('b1', 'audnexus')?.payload).toEqual({
      raw: { description: ELIGIBLE_AUDNEXUS },
      entities: [],
      subjects: [],
    });
  });

  it('rebuilds book_entities so a description-borne character mention is scored, on the run that wrote the description', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    const description = `${'Padding text to clear the minimum length requirement comfortably here. '.repeat(2)}Detective Anna Pigeon investigates.`;
    cacheDescription(db, 'b1', 'audnexus', description);
    // A person candidate confirmed by a provider but with no independent
    // description-match signal until this pass supplies one.
    db.upsertExternalMetadata({
      bookId: 'b1',
      provider: 'openlibrary',
      payload: { raw: {}, entities: [{ entity: 'Anna Pigeon', kind: 'person' }], subjects: [] },
      fetchedAt: 1_000,
      status: 'ok',
    });
    // Pad the allowlist past SMALL_LIST (12) so entities are actually scored
    // rather than trusted wholesale.
    const filler = Array.from({ length: 12 }, (_, i) => ({ entity: `Filler Person ${i}`, kind: 'person' as const, sources: ['openlibrary'] }));
    db.replaceBookEntities('b1', [{ entity: 'Anna Pigeon', kind: 'person', sources: ['openlibrary'] }, ...filler]);

    await backfillDescriptions(db, PROVIDERS);

    const entities = db.getEntitiesForBook('b1');
    const annaPigeon = entities.find((e) => e.entity === 'Anna Pigeon');
    expect(annaPigeon?.notable).toBe(true);
  });
});
