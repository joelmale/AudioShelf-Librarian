import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../db.js';
import { ValidationError } from '../errors.js';
import { composeBookCardFromDb } from '../retrieval/bookCard.js';
import type { Book, ExternalMetadataRecord, TagCategory } from '../types.js';
import { promoteSubjectsFromCache } from './promoteSubjects.js';
import type { EnrichmentPayload } from './types.js';

const databases: CuratorDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

function seedBook(db: CuratorDb, id: string, overrides: Partial<Book> = {}): void {
  db.upsertBook({
    id,
    title: overrides.title ?? `Book ${id}`,
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
  });
}

function seedBooks(db: CuratorDb, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `b${String(i).padStart(2, '0')}`;
    seedBook(db, id);
    ids.push(id);
  }
  return ids;
}

/** Cache a cached-'ok' external_metadata row for `provider`. `payload` is the
 *  same shape the real providers produce: `{ raw, entities: [], subjects }`. */
function okRow(
  db: CuratorDb,
  bookId: string,
  provider: string,
  payload: Partial<EnrichmentPayload> & { subjects?: string[] }
): void {
  db.upsertExternalMetadata({
    bookId,
    provider,
    payload: { raw: payload.raw ?? {}, entities: payload.entities ?? [], subjects: payload.subjects ?? [] },
    fetchedAt: 1_000,
    status: 'ok',
  });
}

function hardcoverRaw(doc: Record<string, unknown>): unknown {
  return { data: { search: { results: { hits: [{ document: doc }] } } } };
}

function proposedTerm(db: CuratorDb, term: string, category: TagCategory) {
  return db.getVocabTerms(['proposed']).find((t) => t.term === term && t.category === category);
}

function anyTerm(db: CuratorDb, term: string, category: TagCategory) {
  return db.getVocabTerms().find((t) => t.term === term && t.category === category);
}

describe('promoteSubjectsFromCache — per-provider facet routing', () => {
  it('googlebooks: BISAC segments propose, the top-level "Fiction" facet never does', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'googlebooks', { subjects: ['Fiction', 'Mystery & Detective', 'Amateur Sleuth'] });
    okRow(db, 'b01', 'googlebooks', { subjects: ['Fiction', 'Mystery & Detective', 'Amateur Sleuth'] });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'mystery-detective', 'genre')).toBeTruthy();
    expect(proposedTerm(db, 'amateur-sleuth', 'genre')).toBeTruthy();
    expect(anyTerm(db, 'fiction', 'genre')).toBeUndefined();
  });

  it('openlibrary: a comma-blob containing "&" stays whole and is stoplisted wholesale', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    okRow(db, 'b00', 'openlibrary', { subjects: ['Fiction, mystery & detective, general'] });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(result.termsProposed).toBe(0);
    expect(db.getVocabTerms(['proposed'])).toHaveLength(0);
  });

  it('openlibrary: a comma-blob with no "&" splits and drops Fiction/general', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['Fiction, science fiction, general'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['Fiction, science fiction, general'] });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'science-fiction', 'theme')).toBeTruthy();
    expect(db.getVocabTerms(['proposed'])).toHaveLength(1);
  });

  it('openlibrary: proposes the UN-folded normalizeTagForm output, not the stopword-folded form', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', {
      subjects: ['horror', 'Detective and mystery stories', 'Boats, Ships & Underwater Craft'],
    });
    okRow(db, 'b01', 'openlibrary', {
      subjects: ['horror', 'Detective and mystery stories', 'Boats, Ships & Underwater Craft'],
    });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'horror', 'theme')).toBeTruthy();
    // NOT the stopword-folded 'detective-mystery-stories'.
    expect(proposedTerm(db, 'detective-and-mystery-stories', 'theme')).toBeTruthy();
    expect(anyTerm(db, 'detective-mystery-stories', 'theme')).toBeUndefined();
    expect(proposedTerm(db, 'boats-ships-underwater-craft', 'theme')).toBeTruthy();
  });

  it('openlibrary: drops a machine tag but keeps a heading that merely contains a colon', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['nyt:trade_fiction_paperback=2011-12-31', 'Fiction: Horror'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['nyt:trade_fiction_paperback=2011-12-31', 'Fiction: Horror'] });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'fiction-horror', 'theme')).toBeTruthy();
    expect(db.getVocabTerms(['proposed'])).toHaveLength(1);
  });

  it('openlibrary: caps at 12 surviving terms from one uncapped subject[] row', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: Array.from({ length: 30 }, (_, i) => `Subjectterm${i}`) });
    okRow(db, 'b01', 'openlibrary', { subjects: Array.from({ length: 30 }, (_, i) => `Subjectterm${i}`) });

    await promoteSubjectsFromCache(db, { dryRun: false });

    const contributed = db.getVocabTerms(['proposed']).filter((t) => t.category === 'theme');
    expect(contributed).toHaveLength(12);
  });

  it('audnexus: proposes genuine misses, a direct seed hit and a single-token fallback hit are both silently already-known', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'audnexus', {
      subjects: ['Science Fiction & Fantasy', 'Science Fiction', 'Adventure', 'Hard Science Fiction', 'Space Opera'],
    });
    okRow(db, 'b01', 'audnexus', {
      subjects: ['Science Fiction & Fantasy', 'Science Fiction', 'Adventure', 'Hard Science Fiction', 'Space Opera'],
    });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'science-fiction', 'genre')).toBeTruthy();
    expect(proposedTerm(db, 'adventure', 'genre')).toBeTruthy();
    expect(proposedTerm(db, 'hard-science-fiction', 'genre')).toBeTruthy();
    // Direct seed-vocab hit: never proposed.
    expect(anyTerm(db, 'space-opera', 'genre')?.status).not.toBe('proposed');
    // Single-token fallback resolves 'Science Fiction & Fantasy' to seed 'fantasy'.
    expect(anyTerm(db, 'science-fiction-fantasy', 'genre')).toBeUndefined();
    expect(anyTerm(db, 'fantasy', 'genre')?.status).toBe('seed');
    expect(result.termsAlreadyKnown).toBeGreaterThanOrEqual(2);
  });

  it('wikidata: P136 genre labels propose when unknown', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'wikidata', { subjects: ['cozy mystery', 'science fiction'] });
    okRow(db, 'b01', 'wikidata', { subjects: ['cozy mystery', 'science fiction'] });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'cozy-mystery', 'genre')).toBeTruthy();
    expect(proposedTerm(db, 'science-fiction', 'genre')).toBeTruthy();
  });

  it('hardcover: recovers genre/mood from `raw`, drops `tags`, and never reads the flattened `subjects`', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'hardcover', {
      raw: hardcoverRaw({ genres: ['Science Fiction'], moods: ['adventurous'], tags: ['Cozy Vibes'] }),
      subjects: ['Science Fiction', 'adventurous', 'Cozy Vibes'],
    });
    okRow(db, 'b01', 'hardcover', {
      raw: hardcoverRaw({ genres: ['Science Fiction'], moods: ['adventurous'], tags: ['Cozy Vibes'] }),
      subjects: ['Science Fiction', 'adventurous', 'Cozy Vibes'],
    });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'science-fiction', 'genre')).toBeTruthy();
    expect(proposedTerm(db, 'adventurous', 'mood')).toBeTruthy();
    expect(anyTerm(db, 'cozy-vibes', 'genre')).toBeUndefined();
    expect(anyTerm(db, 'cozy-vibes', 'mood')).toBeUndefined();
  });

  it('hardcover: reads `raw` even when stored `subjects` is bogus — proves the source, not merely the outcome', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'hardcover', {
      raw: hardcoverRaw({ moods: ['adventurous'] }),
      subjects: ['Totally Bogus'],
    });
    okRow(db, 'b01', 'hardcover', {
      raw: hardcoverRaw({ moods: ['adventurous'] }),
      subjects: ['Totally Bogus'],
    });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'adventurous', 'mood')).toBeTruthy();
    expect(anyTerm(db, 'totally-bogus', 'mood')).toBeUndefined();
    expect(anyTerm(db, 'totally-bogus', 'genre')).toBeUndefined();
  });

  it('hardcover: an unrecognisable `raw` contributes nothing and does NOT fall back to `subjects`', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    okRow(db, 'b00', 'hardcover', {
      raw: { nonsense: true },
      subjects: ['Science Fiction', 'adventurous'],
    });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(result.termsProposed).toBe(0);
    expect(db.getVocabTerms(['proposed'])).toHaveLength(0);
  });

  it('unknown provider and not-found/error rows contribute nothing; the unknown provider counts as skipped', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'openlibrary',
      payload: { raw: {}, entities: [], subjects: ['Cozy'] },
      fetchedAt: 1_000,
      status: 'not-found',
    });
    db.upsertExternalMetadata({
      bookId: 'b00',
      provider: 'googlebooks',
      payload: { raw: {}, entities: [], subjects: ['Cozy'] },
      fetchedAt: 1_000,
      status: 'error',
    });
    okRow(db, 'b00', 'fandom', { subjects: ['Cozy'] });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(result.termsProposed).toBe(0);
    expect(db.getVocabTerms(['proposed'])).toHaveLength(0);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsScanned).toBe(0);
  });
});

describe('promoteSubjectsFromCache — the library-share ceiling', () => {
  it('drops a term evidenced on more than 40% of active books', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    for (const id of ['b00', 'b01', 'b02']) okRow(db, id, 'openlibrary', { subjects: ['Accessible book'] });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(result.termsDroppedCeiling).toBe(1);
    expect(anyTerm(db, 'accessible-book', 'theme')).toBeUndefined();
  });

  it('proposes the same term when it stays under the ceiling', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['Accessible book'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['Accessible book'] });

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(proposedTerm(db, 'accessible-book', 'theme')).toBeTruthy();
  });
});

describe('promoteSubjectsFromCache — the minimum-evidence floor', () => {
  it('does not propose a term evidenced on only one book', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    okRow(db, 'b00', 'openlibrary', { subjects: ['accessible book'] });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(result.termsDroppedMinEvidence).toBe(1);
    expect(anyTerm(db, 'accessible-book', 'theme')).toBeUndefined();
  });

  it('proposes the same term once a second book independently evidences it', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['accessible book'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['accessible book'] });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    expect(result.termsDroppedMinEvidence).toBe(0);
    expect(proposedTerm(db, 'accessible-book', 'theme')).toBeTruthy();
  });
});

describe('promoteSubjectsFromCache — idempotence and pruning', () => {
  it('two consecutive full runs over an unchanged cache produce identical vocab_terms state', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['horror'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['horror'] });

    const first = await promoteSubjectsFromCache(db, { dryRun: false });
    const afterFirst = db.getVocabTerms(['proposed']);
    const second = await promoteSubjectsFromCache(db, { dryRun: false });
    const afterSecond = db.getVocabTerms(['proposed']);

    expect(first.termsProposed).toBe(second.termsProposed);
    expect(first.termsProposed).toBeGreaterThan(0);
    expect(second.termsPruned).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('a term no longer evidenced by the cache is pruned on the next full run — but never on a dry run', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['horror'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['horror'] });
    await promoteSubjectsFromCache(db, { dryRun: false });
    expect(proposedTerm(db, 'horror', 'theme')).toBeTruthy();

    okRow(db, 'b00', 'openlibrary', { subjects: [] });
    okRow(db, 'b01', 'openlibrary', { subjects: [] });

    const dry = await promoteSubjectsFromCache(db, { dryRun: true });
    expect(dry.termsPruned).toBe(0);
    expect(proposedTerm(db, 'horror', 'theme')).toBeTruthy();

    const real = await promoteSubjectsFromCache(db, { dryRun: false });
    expect(real.termsPruned).toBe(1);
    expect(proposedTerm(db, 'horror', 'theme')).toBeUndefined();
  });

  it('leaves a seed, a promoted, and a human-rejected row completely untouched even when the cache evidences the same term', async () => {
    const db = freshDb();
    // 40 total so the 12 evidenced books stay comfortably under the 40%
    // library-share ceiling (12/40 = 30%) — this test is about the
    // status/origin guard on the write, not about the ceiling, so the
    // ceiling must not be what's actually protecting 'cozy' here.
    const ids = seedBooks(db, 40);
    for (const id of ids.slice(0, 12)) {
      okRow(db, id, 'openlibrary', { subjects: ['cozy'] });
      okRow(db, id, 'audnexus', { subjects: ['Fantasy'] });
    }
    db.setVocabTermStatus('cozy', 'theme', 'rejected', 500);
    const beforeRejected = anyTerm(db, 'cozy', 'theme')!;

    db.setVocabTermStatus('fantasy', 'genre', 'promoted', 500); // already seed; flip explicit for the assertion below
    const beforeFantasy = anyTerm(db, 'fantasy', 'genre')!;

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(anyTerm(db, 'cozy', 'theme')).toEqual(beforeRejected);
    expect(anyTerm(db, 'fantasy', 'genre')).toEqual(beforeFantasy);
  });

  it('never upserts, and never prunes, a "tagger"-origin proposed row', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    db.upsertBook({
      id: 'tagger-book',
      title: 'Tagger Book',
      author: null,
      series: null,
      seriesSequence: null,
      durationSeconds: null,
      publishedYear: null,
      genres: [],
      description: null,
      coverPath: null,
      absAddedAt: null,
      lastSyncedAt: 0,
    });
    db.upsertBookTags('tagger-book', [{ tag: 'cozy', category: 'theme', confidence: 0.9, source: 'llm-open' }], 1_000);
    db.refreshProposedVocabCounts(1_000);
    const taggerRow = anyTerm(db, 'cozy', 'theme');
    expect(taggerRow?.origin).toBe('tagger');
    const taggerCount = taggerRow?.bookCount;

    // Two books' cache also evidences 'cozy' (clearing the minimum-evidence
    // floor, so this actually reaches refreshEnrichmentVocabProposals rather
    // than being filtered out before it) — R1 must not steal or touch the
    // origin='tagger' row's `origin`, but its `book_count` legitimately DOES
    // move: MAX(tagger_book_count, enrichment_book_count) is the whole point
    // of tracking both — see refreshProposedVocabCounts/refreshEnrichmentVocabProposals.
    okRow(db, 'b00', 'openlibrary', { subjects: ['cozy'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['cozy'] });
    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    const after = anyTerm(db, 'cozy', 'theme');
    expect(after?.origin).toBe('tagger');
    expect(after?.bookCount).toBe(Math.max(taggerCount ?? 0, 2));
    expect(result.termsPruned).toBe(0);
  });

  it('refreshProposedVocabCounts (the tagger-side promotion queue refresh) never deletes an "enrichment"-origin row', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['horror'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['horror'] });
    await promoteSubjectsFromCache(db, { dryRun: false });
    expect(anyTerm(db, 'horror', 'theme')?.origin).toBe('enrichment');

    // No book_tags of any kind — the pre-existing bug this column fixes would
    // have this call delete the row outright.
    db.refreshProposedVocabCounts(2_000);

    expect(proposedTerm(db, 'horror', 'theme')).toBeTruthy();
    expect(anyTerm(db, 'horror', 'theme')?.origin).toBe('enrichment');
  });
});

describe('promoteSubjectsFromCache — scope, safety, and the write surface', () => {
  it('throws ValidationError when bookIds is passed with dryRun: false', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    await expect(promoteSubjectsFromCache(db, { bookIds: ['b00'], dryRun: false })).rejects.toThrow(ValidationError);
  });

  it('accepts bookIds on a dry run and writes nothing', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'openlibrary', { subjects: ['horror'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['horror'] });

    // The minimum-evidence floor is checked on `entry.bookIds.size` the same
    // way the library-share ceiling is — both are library-wide facts a
    // `bookIds`-scoped walk can only approximate (see the module docblock) —
    // so both b00 and b01 need to be in scope for 'horror' to clear it here.
    const result = await promoteSubjectsFromCache(db, { bookIds: ['b00', 'b01'], dryRun: true });

    expect(result.termsProposed).toBe(1);
    expect(db.getVocabTerms(['proposed'])).toHaveLength(0);
  });

  it('never calls fetch — no network, and no fetchImpl parameter anywhere in the signature', async () => {
    const db = freshDb();
    seedBooks(db, 3);
    okRow(db, 'b00', 'openlibrary', { subjects: ['horror'] });
    okRow(db, 'b01', 'openlibrary', { subjects: ['horror'] });
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('promoteSubjectsFromCache must never fetch');
    });

    // try/finally, not a bare call after the assertions: if either assertion
    // below throws, a bare `globalFetch.mockRestore()` on the next line never
    // runs, and this suite leaves `globalThis.fetch` permanently throwing for
    // every test that runs afterward in the same worker.
    try {
      await expect(promoteSubjectsFromCache(db, { dryRun: false })).resolves.toBeTruthy();
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('never mutates external_metadata (raw, subjects, fetchedAt all byte-identical) and writes no book_tags rows', async () => {
    const db = freshDb();
    seedBooks(db, 2);
    okRow(db, 'b00', 'googlebooks', { raw: { volumeInfo: { categories: ['Fiction / Horror'] } }, subjects: ['Fiction', 'Horror'] });
    okRow(db, 'b01', 'hardcover', { raw: hardcoverRaw({ genres: ['Fantasy'], moods: ['dark'] }), subjects: ['Fantasy', 'dark'] });

    const before: Record<string, ExternalMetadataRecord[]> = {
      b00: db.getExternalMetadata('b00'),
      b01: db.getExternalMetadata('b01'),
    };

    await promoteSubjectsFromCache(db, { dryRun: false });

    expect(db.getExternalMetadata('b00')).toEqual(before.b00);
    expect(db.getExternalMetadata('b01')).toEqual(before.b01);
    expect(db.getTagsForBook('b00')).toEqual([]);
    expect(db.getTagsForBook('b01')).toEqual([]);
  });

  it('leaves every book_embeddings card_hash unchanged — R1 never touches card text (§5 sequencing)', async () => {
    const db = freshDb();
    const ids = seedBooks(db, 3);
    okRow(db, 'b00', 'googlebooks', { subjects: ['Fiction', 'Mystery & Detective'] });
    okRow(db, 'b01', 'hardcover', { raw: hardcoverRaw({ genres: ['Horror'], moods: ['tense'] }), subjects: ['Horror', 'tense'] });

    const before = ids.map((id) => composeBookCardFromDb(db, id)?.hash);

    await promoteSubjectsFromCache(db, { dryRun: false });

    const after = ids.map((id) => composeBookCardFromDb(db, id)?.hash);
    expect(after).toEqual(before);
  });

  it('completes normally, and isolates a book whose cached payload cannot be inspected', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    // A malformed row: payload is a JSON array, not an object with `subjects`.
    db.upsertExternalMetadata({ bookId: 'b00', provider: 'openlibrary', payload: ['not', 'an', 'object'], fetchedAt: 1_000, status: 'ok' });
    okRow(db, 'b01', 'openlibrary', { subjects: ['horror'] });
    okRow(db, 'b02', 'openlibrary', { subjects: ['horror'] });

    const result = await promoteSubjectsFromCache(db, { dryRun: false });

    // An array IS typeof 'object', so this exercises the facet extractor's
    // own defensiveness (asStringArray) rather than the rowsSkipped path —
    // either way nothing throws and the healthy row still proposes.
    expect(result.failed).toBe(0);
    expect(proposedTerm(db, 'horror', 'theme')).toBeTruthy();
  });
});

describe('promoteSubjectsFromCache — downstream of the write (no route changes needed)', () => {
  it('getProposedVocabTerms surfaces origin, with an expected-empty sampleBooks for an enrichment-origin term', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'hardcover', { raw: hardcoverRaw({ moods: ['adventurous'] }) });
    okRow(db, 'b01', 'hardcover', { raw: hardcoverRaw({ moods: ['adventurous'] }) });

    await promoteSubjectsFromCache(db, { dryRun: false });

    const row = db.getProposedVocabTerms().find((t) => t.term === 'adventurous' && t.category === 'mood');
    expect(row).toMatchObject({ status: 'proposed', origin: 'enrichment', sampleBooks: [] });
    expect(row!.bookCount).toBeGreaterThan(0);
  });

  it('promoting an enrichment-origin term behaves exactly like promoting any other: isVocabTerm flips true, retag is a harmless no-op', async () => {
    const db = freshDb();
    seedBooks(db, 10);
    okRow(db, 'b00', 'hardcover', { raw: hardcoverRaw({ moods: ['adventurous'] }) });
    okRow(db, 'b01', 'hardcover', { raw: hardcoverRaw({ moods: ['adventurous'] }) });
    await promoteSubjectsFromCache(db, { dryRun: false });
    expect(db.isVocabTerm('adventurous', 'mood')).toBe(false);

    db.setVocabTermStatus('adventurous', 'mood', 'promoted', 2_000);
    const retag = db.retagLlmOpenTags('adventurous', 'mood', 'adventurous');

    expect(db.isVocabTerm('adventurous', 'mood')).toBe(true);
    expect(retag).toEqual({ changed: 0, bookIds: [] });
  });
});
