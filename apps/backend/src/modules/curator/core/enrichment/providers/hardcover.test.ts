import { describe, expect, it, vi } from 'vitest';

import type { Book } from '../../types.js';
import { createHardcoverProvider, hardcoverReceptionPrior } from './hardcover.js';

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    title: 'Leviathan Wakes',
    author: 'James S. A. Corey',
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

function hits(documents: unknown[]): unknown {
  return { data: { search: { results: { hits: documents.map((document) => ({ document })) } } } };
}

function respondWith(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const MATCH = {
  title: 'Leviathan Wakes',
  author_names: ['James S. A. Corey'],
  rating: 4.2,
  ratings_count: 900,
  genres: ['Science Fiction'],
  moods: ['adventurous'],
};

describe('createHardcoverProvider', () => {
  it('returns null with no token so the caller omits the provider entirely', () => {
    // A provider that always returned null would cache a genuine 'not-found'
    // against every book and suppress re-lookup once a token is added.
    expect(createHardcoverProvider({ token: '   ' })).toBeNull();
  });

  it('maps a verified hit to subjects and caches the raw response', async () => {
    const raw = hits([MATCH]);
    const provider = createHardcoverProvider({ token: 't' })!;
    const payload = await provider.lookup(book(), respondWith(raw));

    expect(payload?.raw).toEqual(raw);
    expect(payload?.subjects).toEqual(['Science Fiction', 'adventurous']);
  });

  it('never emits entities — Hardcover must not feed the grounding allowlist', async () => {
    const provider = createHardcoverProvider({ token: 't' })!;
    const payload = await provider.lookup(book(), respondWith(hits([MATCH])));
    expect(payload?.entities).toEqual([]);
  });

  it('rejects a search hit for a different book rather than attaching its rating', async () => {
    const provider = createHardcoverProvider({ token: 't' })!;
    const payload = await provider.lookup(
      book(),
      respondWith(hits([{ ...MATCH, title: 'Some Entirely Other Book', author_names: ['Nobody'] }]))
    );
    expect(payload).toBeNull();
  });

  it('reports an empty hit list as not-found, but a non-2xx as an error', async () => {
    const provider = createHardcoverProvider({ token: 't' })!;
    await expect(provider.lookup(book(), respondWith(hits([])))).resolves.toBeNull();
    // Conflating these would cache a transport failure as a permanent answer.
    await expect(provider.lookup(book(), respondWith({}, { ok: false, status: 503 }))).rejects.toThrow(/503/);
  });

  it('re-derives subjects from cached raw with no network call', () => {
    const provider = createHardcoverProvider({ token: 't' })!;
    expect(provider.rederive?.(hits([MATCH]))).toEqual({
      entities: [],
      subjects: ['Science Fiction', 'adventurous'],
    });
    expect(provider.rederive?.({ nonsense: true })).toBeNull();
  });
});

describe('hardcoverReceptionPrior', () => {
  it('normalizes a well-rated book onto [0,1]', () => {
    expect(hardcoverReceptionPrior(hits([MATCH]))).toBeCloseTo(0.84);
  });

  it('returns null below the ratings floor rather than trusting a thin average', () => {
    // One enthusiastic friend of the author must not outrank a book with
    // two thousand ratings; null is scored at the ranker's neutral midpoint.
    expect(hardcoverReceptionPrior(hits([{ ...MATCH, rating: 5, ratings_count: 2 }]))).toBeNull();
  });

  it('returns null for a payload with no usable rating', () => {
    expect(hardcoverReceptionPrior(hits([{ ...MATCH, rating: null }]))).toBeNull();
    expect(hardcoverReceptionPrior({})).toBeNull();
  });
});
