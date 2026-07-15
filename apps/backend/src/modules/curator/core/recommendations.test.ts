import { afterEach, describe, expect, it, vi } from 'vitest';
import { CuratorDb } from './db.js';
import type { LlmClient } from './llmClient.js';
import { recommendBooks } from './recommendations.js';
import type { Book, RecommendationResponse } from './types.js';

const databases: CuratorDb[] = [];

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title' | 'author' | 'durationSeconds'>): void {
  db.upsertBook({
    ...input,
    series: null,
    seriesSequence: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
  });
}

function fakeLlm(recommendations: RecommendationResponse): LlmClient {
  return {
    generateRecommendations: vi.fn().mockResolvedValue({
      recommendations,
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  } as unknown as LlmClient;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('recommendBooks', () => {
  it('preserves model order while enforcing seeds, local IDs, ownership, and duration', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'seed', title: 'The Seed', author: 'A. Writer', durationSeconds: 2_000 });
    addBook(db, { id: 'fit', title: 'Shelf Fit', author: 'B. Writer', durationSeconds: 10_000 });
    addBook(db, { id: 'long', title: 'Shelf Epic', author: 'C. Writer', durationSeconds: 30_000 });
    addBook(db, { id: 'unknown-length', title: 'Mystery Length', author: 'D. Writer', durationSeconds: null });
    addBook(db, { id: 'owned', title: 'Already Here', author: 'E. Writer', durationSeconds: 5_000 });
    db.replaceBookTags('fit', [{ tag: 'humorous', category: 'mood', confidence: 0.95 }], Date.now());

    const llmClient = fakeLlm({
      interpretation: 'A light fantasy that fits a six-hour trip.',
      constraints: { maxDurationHours: 6, genres: ['fantasy'], moods: ['light'] },
      shelf: [
        { bookId: 'fit', reason: 'Light and short.' },
        { bookId: 'seed', reason: 'Should never recommend the seed.' },
        { bookId: 'missing', reason: 'A hallucinated local ID.' },
        { bookId: 'long', reason: 'Too long.' },
        { bookId: 'unknown-length', reason: 'Cannot prove it fits.' },
      ],
      external: [
        { title: 'Verified Fit', author: 'F. Writer', reason: 'A verified short fantasy.' },
        { title: 'Already Here', author: 'E. Writer', reason: 'Should be removed as owned.' },
        { title: 'Unknown Runtime', author: 'G. Writer', reason: 'Cannot prove it fits.' },
      ],
    });

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const result = url.includes('Verified%20Fit')
        ? { collectionName: 'Verified Fit (Unabridged)', artistName: 'F. Writer', trackTimeMillis: 18_000_000 }
        : url.includes('Already%20Here')
          ? { collectionName: 'Already Here', artistName: 'E. Writer', trackTimeMillis: 10_000_000 }
          : { collectionName: 'Unknown Runtime', artistName: 'G. Writer' };
      return new Response(JSON.stringify({ results: [result] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await recommendBooks({
      db,
      llmClient,
      prompt: 'Something light and funny for a six hour drive',
      seedBookIds: ['seed'],
      scope: 'both',
      fetchImpl,
    });

    expect(result.onShelf.map((book) => book.id)).toEqual(['fit']);
    expect(result.onShelf[0]?.tags.map((tag) => tag.tag)).toEqual(['humorous']);
    expect(result.available.map((book) => book.title)).toEqual(['Verified Fit']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('honors shelf-only scope without contacting iTunes', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, { id: 'fit', title: 'Shelf Fit', author: 'B. Writer', durationSeconds: 10_000 });
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await recommendBooks({
      db,
      llmClient: fakeLlm({
        interpretation: 'Something from the shelf.',
        constraints: { maxDurationHours: null, genres: [], moods: [] },
        shelf: [{ bookId: 'fit', reason: 'It matches.' }],
        external: [{ title: 'External', author: 'Writer', reason: 'Ignored.' }],
      }),
      prompt: 'Choose for me',
      seedBookIds: [],
      scope: 'shelf',
      fetchImpl,
    });

    expect(result.onShelf.map((book) => book.id)).toEqual(['fit']);
    expect(result.available).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
