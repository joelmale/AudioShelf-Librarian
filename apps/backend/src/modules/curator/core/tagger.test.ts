import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ABSClient } from './absClient.js';
import { CuratorDb } from './db.js';
import type { LlmClient } from './llmClient.js';
import { computeSampleSize, tagUntaggedBooks, type TaggingOptions } from './tagger.js';
import { TAG_CATEGORIES, TAG_SCHEMA_VERSION, type Book, type BookTagResult } from './types.js';

const databases: CuratorDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title'> & Partial<Book>): void {
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

/** Minimal ABSClient stub — the tagger only calls getBook + updateBookTags. */
function fakeAbsClient(): ABSClient {
  return {
    getBook: vi.fn(async () => ({
      id: 'irrelevant',
      media: { metadata: { tags: [] } },
    })),
    updateBookTags: vi.fn(async () => undefined),
  } as unknown as ABSClient;
}

/** LlmClient stub whose tagBook returns one genre tag per call, unless overridden. */
function fakeLlmClient(impl?: (book: Book) => Promise<BookTagResult>): LlmClient {
  const tagBook =
    impl ??
    (async (book: Book) => ({
      bookId: book.id,
      tags: [{ tag: 'noir', category: 'genre' as const, confidence: 0.8 }],
      usage: { inputTokens: 100, outputTokens: 20 },
    }));
  return { tagBook: vi.fn(tagBook) } as unknown as LlmClient;
}

function baseOptions(overrides: Partial<TaggingOptions> = {}): TaggingOptions {
  return {
    concurrency: 4,
    absClient: fakeAbsClient(),
    ...overrides,
  };
}

describe('tagUntaggedBooks — retagAll', () => {
  it('re-tags an already-tagged book, replacing its old tags with the new ones', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookTags('b1', [{ tag: 'stale-genre', category: 'genre', confidence: 0.5, source: 'llm-open' }], Date.now());

    const llmClient = fakeLlmClient();
    const result = await tagUntaggedBooks(llmClient, db, baseOptions({ retagAll: true }));

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    const tags = db.getTagsForBook('b1');
    expect(tags.map((t) => t.tag)).not.toContain('stale-genre');
    expect(tags.map((t) => t.tag)).toContain('noir');
  });

  it('a book whose tagging throws ends up with its tags cleared, but the run continues and other books still succeed', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'good', title: 'Good Book' });
    addBook(db, { id: 'bad', title: 'Bad Book' });
    db.replaceBookTags('good', [{ tag: 'old-good', category: 'genre', confidence: 0.5, source: 'llm-open' }], Date.now());
    db.replaceBookTags('bad', [{ tag: 'old-bad', category: 'genre', confidence: 0.5, source: 'llm-open' }], Date.now());

    const llmClient = fakeLlmClient(async (book) => {
      if (book.id === 'bad') throw new Error('LLM exploded');
      return {
        bookId: book.id,
        tags: [{ tag: 'noir', category: 'genre' as const, confidence: 0.8 }],
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    });

    const result = await tagUntaggedBooks(llmClient, db, baseOptions({ retagAll: true, concurrency: 1 }));

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe('bad');

    // The failing book is left with NO tags (cleared, not regenerated) — the
    // blast radius of the failure is exactly this one book.
    expect(db.getTagsForBook('bad')).toHaveLength(0);
    // The good book still succeeded and carries its new tags.
    expect(db.getTagsForBook('good').map((t) => t.tag)).toContain('noir');

    // Readiness plan item B: 'bad' is recorded FAILED but its book_tags
    // genuinely changed (pre-clear, then wiped for real in the catch — net:
    // no tags, which is different from whatever the stored embedding
    // encodes), so it still belongs in processedBookIds. A re-embed trigger
    // scoped to this field must not skip it.
    expect(result.processedBookIds.sort()).toEqual(['bad', 'good']);
  });

  it('dry-run makes zero LLM calls and reports a plan covering already-tagged books', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'tagged', title: 'Tagged Book' });
    addBook(db, { id: 'untagged', title: 'Untagged Book' });
    db.replaceBookTags('tagged', [{ tag: 'existing', category: 'genre', confidence: 0.5, source: 'llm-open' }], Date.now());

    const llmClient = fakeLlmClient();
    const result = await tagUntaggedBooks(llmClient, db, baseOptions({ retagAll: true, dryRun: true }));

    expect(llmClient.tagBook).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.plan?.map((p) => p.bookId).sort()).toEqual(['tagged', 'untagged']);
    expect(result.skipped).toBe(2);

    // Dry run never clears anything.
    expect(db.getTagsForBook('tagged').map((t) => t.tag)).toContain('existing');
  });

  it('caps a sample at 40, and takes 5% when that is smaller', () => {
    // The rule is min(40, 5%) — a CEILING. It was max(20, 5%), a floor
    // wearing the label "max 20 or 5%": on a small pool that forced 20 books
    // when 5% meant 5, and on a large one it ran the full 5% uncapped, so a
    // 10,000-book pool "sampled" 500. Asserted with literals on purpose; the
    // sibling test below compares against computeSampleSize itself and so
    // cannot notice the rule changing underneath it.
    expect(computeSampleSize(10_000)).toBe(40);
    expect(computeSampleSize(800)).toBe(40);
    expect(computeSampleSize(796)).toBe(40);
    // Below the cap, 5% wins.
    expect(computeSampleSize(100)).toBe(5);
    expect(computeSampleSize(40)).toBe(2);
    // Never more than the pool, and a single candidate still yields one.
    expect(computeSampleSize(1)).toBe(1);
    expect(computeSampleSize(0)).toBe(0);
    // An explicit override is honoured, still clamped to the pool.
    expect(computeSampleSize(10_000, 5)).toBe(5);
    expect(computeSampleSize(3, 500)).toBe(3);
  });

  it('sample mode limits the retag-all set to computeSampleSize(candidateCount)', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    const total = 40;
    for (let i = 0; i < total; i += 1) {
      addBook(db, { id: `b${i}`, title: `Book ${i}` });
    }

    const llmClient = fakeLlmClient();
    const result = await tagUntaggedBooks(llmClient, db, baseOptions({ retagAll: true, sample: true }));

    const expected = computeSampleSize(total);
    expect(result.processed).toBe(expected);
    expect(llmClient.tagBook).toHaveBeenCalledTimes(expected);
  });
});

/** Metadata that makes every TAG_CATEGORIES member evaluable per
 *  evaluableTagCategories (finding 4): a publishedYear for era, a
 *  durationSeconds for length, and a description for character's weak
 *  substring fallback (no book_entities needed). */
const FULLY_EVALUABLE_FIELDS: Partial<Book> = {
  publishedYear: 2020,
  durationSeconds: 10 * 3600,
  description: 'A long description mentioning nothing in particular.',
};

describe('tagUntaggedBooks — tag_runs (librarian engine plan §10.A)', () => {
  it('records a tag_runs row attempting every TAG_CATEGORIES member when every category is evaluable', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One', ...FULLY_EVALUABLE_FIELDS });

    const llmClient = fakeLlmClient();
    const result = await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(result.processed).toBe(1);
    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(1);
    expect(new Set(runs[0]?.categories)).toEqual(new Set(TAG_CATEGORIES));
    expect(runs[0]?.schemaVersion).toBe(TAG_SCHEMA_VERSION);
  });

  it('a book whose tagging throws gets no tag_runs row — the run recorded is only for what actually completed', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'bad', title: 'Bad Book' });

    const llmClient = fakeLlmClient(async () => {
      throw new Error('LLM exploded');
    });
    const result = await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(result.failed).toBe(1);
    expect(db.getTagRunsForBook('bad')).toEqual([]);
  });

  it('retagAll records a fresh tag_runs row on top of the earlier one, so getAuditedCategories reflects both', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One', ...FULLY_EVALUABLE_FIELDS });
    db.recordTagRun('b1', ['genre'], TAG_SCHEMA_VERSION, 500);

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions({ retagAll: true }));

    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(2);
    const audited = db.getAuditedCategories(['b1']);
    expect(audited.get('b1')).toEqual(new Set(TAG_CATEGORIES));
  });
});

describe('tagUntaggedBooks — recorded categories reflect what the run could actually evaluate (finding 4)', () => {
  it('a book with no publishedYear/durationSeconds/description/entities does not record era, length, or character', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' }); // every metadata field null

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(1);
    const categories = new Set(runs[0]?.categories);
    expect(categories.has('era')).toBe(false);
    expect(categories.has('length')).toBe(false);
    expect(categories.has('character')).toBe(false);
    // Everything else the LLM is actually asked about is still recorded as
    // attempted — this is not a blanket "record nothing" fallback.
    expect(categories.has('genre')).toBe(true);
    expect(categories.has('setting')).toBe(true);
    expect(categories.has('trope')).toBe(true);
  });

  it('a book WITH a publishedYear records era as attempted, regardless of what deriveEra produced', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One', publishedYear: 1975 });

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    const runs = db.getTagRunsForBook('b1');
    expect(new Set(runs[0]?.categories).has('era')).toBe(true);
    // Evaluable, not merely "produced": getTagCoverage must report the
    // absence of an unrelated era tag as absent, not unaudited.
    const coverage = db.getTagCoverage([{ tag: 'golden-age', category: 'era' }], { bookIds: ['b1'] });
    expect(coverage.entries[0]?.absent.bookIds).toEqual(['b1']);
  });

  it('a book WITH a durationSeconds records length as attempted', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One', durationSeconds: 5 * 3600 });

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(new Set(db.getTagRunsForBook('b1')[0]?.categories).has('length')).toBe(true);
  });

  it('a book with a description (no person allowlist) records character as attempted', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One', description: 'Something happens to someone.' });

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(new Set(db.getTagRunsForBook('b1')[0]?.categories).has('character')).toBe(true);
  });

  it('a book with a grounded person entity (no description) records character as attempted', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    db.replaceBookEntities('b1', [{ entity: 'Jane Doe', kind: 'person', sources: ['openlibrary'] }]);

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(new Set(db.getTagRunsForBook('b1')[0]?.categories).has('character')).toBe(true);
  });

  it('setting is always recorded as attempted, even on a fully unenriched book', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(new Set(db.getTagRunsForBook('b1')[0]?.categories).has('setting')).toBe(true);
  });

  it('a trope the LLM was asked about and did not return is still absent, never unaudited', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' }); // no metadata at all

    // fakeLlmClient's default impl returns only a genre tag — no trope tag.
    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions());

    const coverage = db.getTagCoverage([{ tag: 'chosen-one', category: 'trope' }], { bookIds: ['b1'] });
    expect(coverage.entries[0]?.absent.bookIds).toEqual(['b1']);
    expect(coverage.entries[0]?.unaudited.count).toBe(0);
  });
});

describe('tagUntaggedBooks — processedBookIds means "book_tags changed", not "task succeeded" (readiness plan item B)', () => {
  it('a non-retag run whose AUTO_PUSH mirror to ABS fails still lists the book: curator.db already committed the new tags before the push ran, and nothing wipes them back out on a non-retag path', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const absClient = {
      getBook: vi.fn(async () => ({ id: 'b1', media: { metadata: { tags: [] } } })),
      updateBookTags: vi.fn(async () => {
        throw new Error('ABS unreachable');
      }),
    } as unknown as ABSClient;

    const llmClient = fakeLlmClient();
    const result = await tagUntaggedBooks(llmClient, db, baseOptions({ absClient, autoPush: true }));

    // Recorded as a failure of THIS task (the ABS push threw)...
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.id).toBe('b1');

    // ...but curator.db is the system of record (invariant 2) and already
    // committed the new tags before the push ran; this is not a retag, so
    // nothing clears them back out.
    expect(db.getTagsForBook('b1').map((t) => t.tag)).toContain('noir');

    // The book's card DID change, so it must still be scheduled for a
    // re-embed even though the task itself is reported failed — a re-embed
    // trigger scoped to `processed`/successful ids alone would miss it
    // silently, forever (until something else happens to touch this book).
    expect(result.processedBookIds).toEqual(['b1']);
  });

  it('a book whose tagging fails outright (no write ever happened, no retag) is absent from processedBookIds — nothing about its card changed', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

    const llmClient = fakeLlmClient(async () => {
      throw new Error('LLM exploded');
    });
    const result = await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(result.failed).toBe(1);
    expect(db.getTagsForBook('b1')).toHaveLength(0);
    expect(result.processedBookIds).toEqual([]);
  });

  it('the happy path lists every successfully tagged book', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });
    addBook(db, { id: 'b2', title: 'Book Two' });

    const llmClient = fakeLlmClient();
    const result = await tagUntaggedBooks(llmClient, db, baseOptions());

    expect(result.processedBookIds.sort()).toEqual(['b1', 'b2']);
  });
});
