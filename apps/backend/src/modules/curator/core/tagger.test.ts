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

describe('tagUntaggedBooks — tag_runs (librarian engine plan §10.A)', () => {
  it('records a tag_runs row attempting every TAG_CATEGORIES member at the current schema version', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'b1', title: 'Book One' });

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
    addBook(db, { id: 'b1', title: 'Book One' });
    db.recordTagRun('b1', ['genre'], TAG_SCHEMA_VERSION, 500);

    const llmClient = fakeLlmClient();
    await tagUntaggedBooks(llmClient, db, baseOptions({ retagAll: true }));

    const runs = db.getTagRunsForBook('b1');
    expect(runs).toHaveLength(2);
    const audited = db.getAuditedCategories(['b1']);
    expect(audited.get('b1')).toEqual(new Set(TAG_CATEGORIES));
  });
});
