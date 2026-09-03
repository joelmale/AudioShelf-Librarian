import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { composeBookCard } from '../retrieval/bookCard.js';
import type { Book, DescriptionSource } from '../types.js';
import { backfillDescriptions } from './descriptionBackfill.js';
import { MAX_HARVESTED_DESCRIPTION_CHARS, MIN_HARVESTED_DESCRIPTION_CHARS } from './descriptionText.js';
import { openLibraryProvider } from './providers/openLibrary.js';
import { wikidataProvider } from './providers/wikidata.js';
import type { EnrichmentPayload, EnrichmentProvider } from './types.js';

const databases: CuratorDb[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

/** A file-backed DB path so a second, raw better-sqlite3 connection can
 *  inspect or mutate columns `CuratorDb`'s own API won't let a caller reach —
 *  same pattern as `db.enrichmentColumns.test.ts`. */
function tempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, 'lib.db');
}

/** The raw-SQL split-pair count the R5/R8 binding decision requires stay at
 *  0 after every `backfillDescriptions` run: a row where
 *  `description_enriched` is set but `description_source` is NULL. Checked
 *  at the SQL layer, bypassing `CuratorDb#getBook`'s decode, so a bug that
 *  reproduces the split state but happens to decode innocuously cannot hide
 *  from it. */
function splitPairCount(dbPath: string): number {
  const raw = new Database(dbPath);
  const row = raw
    .prepare('SELECT COUNT(*) AS c FROM books WHERE description_enriched IS NOT NULL AND description_source IS NULL')
    .get() as { c: number };
  raw.close();
  return row.c;
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
 *  `DESCRIPTION_SOURCE_PRECEDENCE`
 *  (['audnexus', 'wikidata', 'googlebooks', 'openlibrary']) picks them up.
 *  `extractDescription` reads `raw.description` verbatim, matching every
 *  real provider's contract (uncleaned text out). Takes any
 *  `DescriptionSource` name — not just 'audnexus'/'googlebooks' — so the
 *  R5/R8 contract tests below can stand in for a `'wikidata'`/`'openlibrary'`
 *  provider that HAS implemented the hook, mirroring what those slices add. */
function stubProvider(name: DescriptionSource): EnrichmentProvider {
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
const ELIGIBLE_WIKIDATA = 'A Wikipedia-intro-style synopsis, encyclopedic in register, comfortably past eighty characters.';
const ELIGIBLE_GOOGLEBOOKS = 'A print-edition synopsis, also comfortably past the eighty character minimum length.';
const ELIGIBLE_OPENLIBRARY = 'A work-level synopsis spanning every edition, also comfortably past eighty characters.';

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

  // Adversarial-review finding (major): this is the integration proof that
  // was missing — deleting the `cleanHarvestedDescription` call out of the
  // pass previously left the whole suite green. This test fails on that
  // mutant: it asserts, through the ACTUAL pass (not the pure cleaner in
  // isolation), that HTML/entity-escaped markup in a cached provider payload
  // never reaches `description_enriched`, and — going one step further, per
  // the reviewer's own end-to-end probe — never reaches a composed card
  // either.
  it('cleans HTML and entity-escaped markup out of the cached payload before storing, so it never reaches description_enriched or a composed card', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    const dirty =
      '<p>A gripping tale of the deep.</p><!-- hidden marketing --><style>p{color:red}</style>' +
      '&lt;i&gt;Now a major motion picture&lt;/i&gt;. More padding text to clear the eighty character floor.';
    cacheDescription(db, 'b1', 'audnexus', dirty);

    const result = await backfillDescriptions(db, PROVIDERS);
    expect(result.descriptionsWritten).toBe(1);

    const stored = db.getBook('b1')!.descriptionEnriched;
    expect(stored).toBe(
      'A gripping tale of the deep. Now a major motion picture. More padding text to clear the eighty character floor.'
    );
    expect(stored).not.toContain('<');
    expect(stored).not.toContain('>');
    expect(stored).not.toContain('hidden marketing');
    expect(stored).not.toContain('color:red');

    const book = db.getBook('b1')!;
    const card = composeBookCard(book, [], []);
    expect(card.text).toContain('Now a major motion picture');
    expect(card.text).not.toContain('<');
    expect(card.text).not.toContain('>');
    expect(card.text).not.toContain('hidden marketing');
    expect(card.text).not.toContain('color:red');
  });
});

// R5/R8 contract-widening commit (docs/enrichment-sources-review.md, R5/R8
// binding decision): DescriptionSource/DESCRIPTION_SOURCES/
// DESCRIPTION_SOURCE_PRECEDENCE gain 'wikidata' and 'openlibrary'. These
// tests cover the decision's central safety claim — the widening is a
// provable data no-op until each provider implements `extractDescription`
// (R5/R8's own, later, out-of-scope-here work) — and the retrieval-quality
// consequences that DO apply once a hook exists.
describe('DescriptionSource contract widening (R5/R8 binding decision)', () => {
  // Adversarial-review finding (major): the previous two tests here seeded
  // an eligible AUDNEXUS row alongside the wikidata/openlibrary ones, and
  // audnexus sits first in DESCRIPTION_SOURCE_PRECEDENCE — so
  // `computeDescriptionWinner`'s loop picks it and `break`s before ever
  // reaching wikidata's or openlibrary's row. Both tests passed for that
  // reason, not because the extractDescription gate held: neutralizing the
  // gate (`if (!provider?.extractDescription) continue` -> `if (!provider)
  // continue`, plus a raw-payload fallback extractor) left both green. The
  // two tests below are audnexus-free specifically so the result cannot be
  // explained by precedence position, and they exercise the REAL, registered
  // `wikidataProvider`/`openLibraryProvider` rather than `noHookProvider`
  // stand-ins, so they are sensitive to those providers actually lacking the
  // hook — not just to a stand-in being told to.
  it('production precondition this decision rests on: the real, registered wikidataProvider/openLibraryProvider do not implement extractDescription yet', () => {
    expect(wikidataProvider.extractDescription).toBeUndefined();
    expect(openLibraryProvider.extractDescription).toBeUndefined();
  });

  it('is a provable data no-op at contract-commit time: with ONLY the real wikidataProvider/openLibraryProvider registered (no audnexus in the mix), an eligible-looking cached row from either yields no candidate at all', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'wikidata', ELIGIBLE_WIKIDATA);
    cacheDescription(db, 'b1', 'openlibrary', ELIGIBLE_OPENLIBRARY);

    const result = await backfillDescriptions(db, [wikidataProvider, openLibraryProvider]);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBeNull();
    expect(book.descriptionEnriched).toBeNull();
    expect(result.changedBookIds).toEqual([]);
    expect(result.descriptionsWritten).toBe(0);
  });

  // Distinct from the no-op proof above: this shows the widening is harmless
  // to a book ALREADY backfilled from audnexus — i.e. audnexus's normal
  // precedence win short-circuits computeDescriptionWinner's loop before it
  // ever reaches wikidata/openlibrary, so their mere (hookless) presence in
  // `providers` cannot perturb an existing audnexus attribution. This is a
  // stability property, not a re-test of the extractDescription gate itself
  // (the loop never gets far enough to exercise that gate here) — the gate
  // is what the audnexus-free test above proves.
  it('an audnexus-backfilled book is stable against the widening: changedBookIds/cardTextChanged stay empty and the card hash is byte-identical, with the real wikidataProvider/openLibraryProvider present but hookless', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    cacheDescription(db, 'b1', 'wikidata', ELIGIBLE_WIKIDATA);
    cacheDescription(db, 'b1', 'openlibrary', ELIGIBLE_OPENLIBRARY);
    db.setEnrichedDescription('b1', { text: ELIGIBLE_AUDNEXUS, source: 'audnexus' });

    const before = composeBookCard(db.getBook('b1')!, [], []).hash;

    const providers = [stubProvider('audnexus'), wikidataProvider, openLibraryProvider];
    const result = await backfillDescriptions(db, providers);

    expect(result.changedBookIds).toEqual([]);
    expect(result.cardTextChanged).toBe(0);
    const after = composeBookCard(db.getBook('b1')!, [], []).hash;
    expect(after).toBe(before);
  });

  it('re-attributes a book from googlebooks to wikidata once a wikidata provider implements extractDescription, changing the card hash (deliberate: precedence is recomputed from scratch every run)', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);
    db.setEnrichedDescription('b1', { text: ELIGIBLE_GOOGLEBOOKS, source: 'googlebooks' });
    const before = composeBookCard(db.getBook('b1')!, [], []).hash;

    cacheDescription(db, 'b1', 'wikidata', ELIGIBLE_WIKIDATA);
    const providers = [stubProvider('googlebooks'), stubProvider('wikidata')];
    const result = await backfillDescriptions(db, providers);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBe('wikidata');
    expect(book.descriptionEnriched).toBe(ELIGIBLE_WIKIDATA);
    expect(result.changedBookIds).toEqual(['b1']);
    expect(result.cardTextChanged).toBe(1);
    const after = composeBookCard(book, [], []).hash;
    expect(after).not.toBe(before);
  });

  it('never lets wikidata (or googlebooks) displace audnexus, even when audnexus is added after the others are already winning', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'wikidata', ELIGIBLE_WIKIDATA);
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);
    const providers = [stubProvider('audnexus'), stubProvider('wikidata'), stubProvider('googlebooks')];
    await backfillDescriptions(db, providers);
    expect(db.getBook('b1')?.descriptionSource).toBe('wikidata');

    cacheDescription(db, 'b1', 'audnexus', ELIGIBLE_AUDNEXUS);
    await backfillDescriptions(db, providers);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBe('audnexus');
    expect(book.descriptionEnriched).toBe(ELIGIBLE_AUDNEXUS);
  });

  it('openlibrary is a floor: it wins when it is the only eligible candidate, then is immediately demoted the moment a googlebooks candidate becomes eligible too', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'openlibrary', ELIGIBLE_OPENLIBRARY);
    const providers = [stubProvider('googlebooks'), stubProvider('openlibrary')];

    const first = await backfillDescriptions(db, providers);
    expect(db.getBook('b1')?.descriptionSource).toBe('openlibrary');
    expect(first.changedBookIds).toEqual(['b1']);

    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);
    const second = await backfillDescriptions(db, providers);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBe('googlebooks');
    expect(book.descriptionEnriched).toBe(ELIGIBLE_GOOGLEBOOKS);
    expect(second.changedBookIds).toEqual(['b1']);
  });

  // Known wart pin (adversarial-review finding, minor): `changed` is keyed on
  // `existingSource !== winner.source`, not on text equality, so a
  // re-attribution to a byte-identical cleaned text still lands in
  // `changedBookIds` and pays for a needless re-embed via
  // `api/routes/enrichment.ts`'s `reembedAffectedBooks(... result.changedBookIds
  // ...)`. Pre-existing behaviour (not introduced by the R5/R8 contract
  // widening), correctly not fixed here — the widening enlarges the
  // population that can hit it, since `descriptionText.ts`'s
  // DESCRIPTION_SOURCE_PRECEDENCE docblock itself notes OL work descriptions
  // are "frequently a copy of a publisher blurb or a Wikipedia paragraph".
  // Pinned so a future change to `changed`'s definition (e.g. "leave alone
  // when text is unchanged") has to consciously decide what happens here,
  // not silently break under an unrelated refactor.
  it('KNOWN WART (pre-existing, out of scope here): a re-attribution to byte-identical cleaned text still counts as changed and triggers a re-embed, even though the resolved text and card hash never move', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'openlibrary', ELIGIBLE_OPENLIBRARY);
    await backfillDescriptions(db, [stubProvider('openlibrary')]);
    expect(db.getBook('b1')?.descriptionSource).toBe('openlibrary');

    // A higher-precedence googlebooks row appears whose cleaned text happens
    // to be byte-identical to what is already stored.
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_OPENLIBRARY);
    const before = composeBookCard(db.getBook('b1')!, [], []).hash;

    const result = await backfillDescriptions(db, [stubProvider('googlebooks'), stubProvider('openlibrary')]);

    const book = db.getBook('b1')!;
    expect(book.descriptionSource).toBe('googlebooks'); // re-attributed...
    expect(book.descriptionEnriched).toBe(ELIGIBLE_OPENLIBRARY); // ...to the same text.
    expect(result.changedBookIds).toEqual(['b1']); // still flagged as changed...
    expect(result.cardTextChanged).toBe(0); // ...even though the resolved text didn't move...
    expect(composeBookCard(book, [], []).hash).toBe(before); // ...and neither did the card hash.
  });

  // Known-divergence pin: the R2 errata (docs/enrichment-sources-review.md,
  // lines ~332-335) claims an absent provider is "treated as unknown, not as
  // 'no candidate'" — specifically to avoid a bare unset GOOGLE_BOOKS_API_KEY
  // silently clearing every googlebooks-sourced description library-wide.
  // THAT CODE DOES NOT EXIST: computeDescriptionWinner (descriptionBackfill.ts)
  // just `continue`s past a provider absent from the passed `providers` map,
  // and the caller then clears the stored pair because there is no eligible
  // candidate at all. This test pins the REAL (current) behaviour rather than
  // the doc's claim, so the R5/R8 widening does not silently inherit an
  // unverified assumption. It is a pre-existing defect, out of scope for this
  // contract commit, and reported rather than fixed here.
  it('KNOWN DIVERGENCE from the R2 errata doc: a provider absent from the passed providers array is treated as "no candidate" and clears an existing stored description, not preserved as "unknown"', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Book' });
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);
    db.setEnrichedDescription('b1', { text: ELIGIBLE_GOOGLEBOOKS, source: 'googlebooks' });

    // Simulates an unset GOOGLE_BOOKS_API_KEY: googlebooks is entirely
    // absent from the providers array passed to this run.
    const result = await backfillDescriptions(db, [stubProvider('audnexus')]);

    const book = db.getBook('b1')!;
    expect(book.descriptionEnriched).toBeNull();
    expect(book.descriptionSource).toBeNull();
    expect(result.descriptionsCleared).toBe(1);
    expect(result.changedBookIds).toEqual(['b1']);
  });

  it('self-heals a genuine split pair (descriptionEnriched set, descriptionSource NULL at the SQL layer — the rollback-decode state types.ts documents) by rewriting it once an eligible candidate exists', async () => {
    const dbPath = tempDbPath('audioshelf-db-splitpair-heal-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    // Construct the split pair directly at the SQL layer — the state a
    // rollback decode produces (types.ts's descriptionSource docblock) and
    // that `setEnrichedDescription` can never itself write, since it always
    // sets both columns together. A prior version of this test called
    // `setEnrichedDescription` with a fully recognised source, which never
    // produces a split pair at all (adversarial-review finding).
    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE books SET description_enriched = ?, description_source = NULL WHERE id = ?')
      .run('Pre-existing harvested text long enough to pass the floor.', 'b1');
    raw.close();
    expect(splitPairCount(dbPath)).toBe(1);

    const db = new CuratorDb(dbPath);
    databases.push(db);
    cacheStatus(db, 'b1', 'audnexus', 'not-found'); // audnexus does not resolve
    cacheDescription(db, 'b1', 'googlebooks', ELIGIBLE_GOOGLEBOOKS);

    const result = await backfillDescriptions(db, [stubProvider('audnexus'), stubProvider('googlebooks')]);

    const book = db.getBook('b1')!;
    expect(book.descriptionEnriched).toBe(ELIGIBLE_GOOGLEBOOKS);
    expect(book.descriptionSource).toBe('googlebooks');
    expect(result.changedBookIds).toEqual(['b1']);
    // The binding decision's required proof: no split pair survives a run,
    // checked at the SQL layer rather than through getBook's decode.
    expect(splitPairCount(dbPath)).toBe(0);
  });

  it('self-heals a genuine split pair with NO eligible candidate by clearing both columns together, leaving no stuck state', async () => {
    const dbPath = tempDbPath('audioshelf-db-splitpair-clear-');
    const seed = new CuratorDb(dbPath);
    addBook(seed, { id: 'b1', title: 'Book' });
    seed.close();

    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE books SET description_enriched = ?, description_source = NULL WHERE id = ?')
      .run('Pre-existing harvested text long enough to pass the floor.', 'b1');
    raw.close();
    expect(splitPairCount(dbPath)).toBe(1);

    const db = new CuratorDb(dbPath);
    databases.push(db);
    cacheStatus(db, 'b1', 'audnexus', 'not-found');

    const result = await backfillDescriptions(db, [stubProvider('audnexus')]);

    const book = db.getBook('b1')!;
    expect(book.descriptionEnriched).toBeNull();
    expect(book.descriptionSource).toBeNull();
    expect(result.descriptionsCleared).toBe(1);
    expect(splitPairCount(dbPath)).toBe(0);
  });
});
