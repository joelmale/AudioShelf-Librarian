import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import { audnexusProvider } from './audnexus.js';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    asin: 'B08G9PRS1K',
    ...overrides,
  };
}

/** Shape returned by GET /books/search — same volume shape, in an array. */
const SEARCH_HIT = {
  asin: 'B08G9PRS1K',
  title: 'Project Hail Mary',
  authors: [{ name: 'Andy Weir' }],
  genres: [
    { asin: 'g1', name: 'Science Fiction & Fantasy', type: 'genre' },
    { asin: 't1', name: 'Science Fiction', type: 'tag' },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const VERIFIED_RESPONSE = {
  asin: 'B08G9PRS1K',
  authors: [{ name: 'Andy Weir' }],
  description: 'A lone astronaut must save the earth from disaster.',
  genres: [
    { asin: 'g1', name: 'Science Fiction & Fantasy', type: 'genre' },
    { asin: 'g2', name: 'Science Fiction', type: 'genre' },
    { asin: 't1', name: 'Adventure', type: 'tag' },
    { asin: 't2', name: 'Hard Science Fiction', type: 'tag' },
    { asin: 't3', name: 'Space Opera', type: 'tag' },
  ],
  narrators: [{ name: 'Ray Porter' }],
  runtimeLengthMin: 970,
  rating: '4.9',
  releaseDate: '2021-05-04T00:00:00.000Z',
};

describe('audnexusProvider', () => {
  it('has the stable provider name', () => {
    expect(audnexusProvider.name).toBe('audnexus');
  });

  it('resolves a verified ASIN into subjects from both genre and tag entries, with raw preserved and no entities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, VERIFIED_RESPONSE));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.audnex.us/books/B08G9PRS1K',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result).not.toBeNull();
    expect(result?.entities).toEqual([]);
    expect(result?.raw).toEqual(VERIFIED_RESPONSE);
    expect(result?.subjects).toEqual([
      'Science Fiction & Fantasy',
      'Science Fiction',
      'Adventure',
      'Hard Science Fiction',
      'Space Opera',
    ]);
  });

  // Audiobookshelf only populates `asin` when it matched an item against
  // Audible, so an ASIN-only provider skipped every unmatched book. These now
  // fall back to /books/search rather than giving up.
  it('falls back to search when the book has no asin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, [SEARCH_HIT]));
    const result = await audnexusProvider.lookup(makeBook({ asin: null }), fetchImpl as unknown as typeof fetch);

    expect(result?.subjects).toContain('Science Fiction');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('/books/search?q=');
  });

  it('falls back to search when the asin is an empty/whitespace string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, [SEARCH_HIT]));
    const result = await audnexusProvider.lookup(makeBook({ asin: '   ' }), fetchImpl as unknown as typeof fetch);

    expect(result).not.toBeNull();
    expect(fetchImpl.mock.calls[0][0]).toContain('/books/search?q=');
  });

  it('returns null without fetching when there is neither an asin nor a title', async () => {
    const fetchImpl = vi.fn();
    const result = await audnexusProvider.lookup(
      makeBook({ asin: null, title: '' }),
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a search hit whose author disagrees, rather than caching the wrong book', async () => {
    const wrong = { ...SEARCH_HIT, authors: [{ name: 'Someone Else Entirely' }] };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, [wrong]));
    const result = await audnexusProvider.lookup(makeBook({ asin: null }), fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it('returns null when search returns an empty array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const result = await audnexusProvider.lookup(makeBook({ asin: null }), fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it('stops searching further title candidates once throttled (429)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    await expect(
      audnexusProvider.lookup(makeBook({ asin: null }), fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/throttl/i);
    // Must NOT keep trying the remaining candidates after a throttle.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null on HTTP 404 (unknown ASIN)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not found' }));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it('throws a typed AppError on HTTP 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    await expect(audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch))
      .rejects.toBeInstanceOf(AppError);
  });

  it('throws a typed AppError on invalid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as unknown as Response);
    await expect(audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch))
      .rejects.toBeInstanceOf(AppError);
  });

  it('throws a typed AppError when the fetch itself fails (network/timeout)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch))
      .rejects.toBeInstanceOf(AppError);
  });

  it('returns an empty subjects array when genres is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { asin: 'B08G9PRS1K' }));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(result?.subjects).toEqual([]);
  });

  it('returns an empty subjects array when genres is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { asin: 'B08G9PRS1K', genres: [] }));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(result?.subjects).toEqual([]);
  });

  it('dedupes subjects that differ only in case, keeping the first-seen form', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      asin: 'B08G9PRS1K',
      genres: [
        { name: 'Science Fiction', type: 'genre' },
        { name: 'science fiction', type: 'tag' },
      ],
    }));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(result?.subjects).toEqual(['Science Fiction']);
  });

  it('skips genre entries with blank/whitespace-only names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      asin: 'B08G9PRS1K',
      genres: [
        { name: '', type: 'genre' },
        { name: '   ', type: 'tag' },
        { name: 'Adventure', type: 'tag' },
      ],
    }));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(result?.subjects).toEqual(['Adventure']);
  });

  it('ignores genre entries whose type is neither genre nor tag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      asin: 'B08G9PRS1K',
      genres: [
        { name: 'Should Be Ignored', type: 'series' },
        { name: 'Adventure', type: 'tag' },
      ],
    }));
    const result = await audnexusProvider.lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(result?.subjects).toEqual(['Adventure']);
  });
});
