import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import { createGoogleBooksProvider, extractSubjects } from './googleBooks.js';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'A Curiously Convenient Demise',
    author: 'Hannah Hendy',
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    ...overrides,
  } as Book;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Shaped after the real volume for `4MhgEQAAQBAJ`. */
const VOLUME = {
  id: '4MhgEQAAQBAJ',
  volumeInfo: {
    title: 'A Curiously Convenient Demise',
    authors: ['Hannah Hendy'],
    publisher: 'Penguin',
    publishedDate: '2025-10-16',
    description: 'A charity auction at Summerview Secondary School turns deadly.',
    pageCount: 320,
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9798217266463' }],
    categories: [
      'Fiction / Mystery & Detective / Amateur Sleuth',
      'Fiction / Mystery & Detective / Cozy / General',
      'Fiction / Mystery & Detective / Women Sleuths',
    ],
  },
};

const provider = () => {
  const p = createGoogleBooksProvider('test-key');
  if (!p) throw new Error('expected a provider for a non-empty key');
  return p;
};

describe('createGoogleBooksProvider', () => {
  it('returns null when no API key is configured', () => {
    expect(createGoogleBooksProvider(undefined)).toBeNull();
    expect(createGoogleBooksProvider(null)).toBeNull();
    expect(createGoogleBooksProvider('')).toBeNull();
    expect(createGoogleBooksProvider('   ')).toBeNull();
  });

  it('builds a provider named googlebooks when a key is present', () => {
    expect(provider().name).toBe('googlebooks');
  });
});

describe('extractSubjects', () => {
  it('splits BISAC paths into segments, drops "General", and dedupes', () => {
    expect(extractSubjects(VOLUME.volumeInfo.categories)).toEqual([
      'Fiction',
      'Mystery & Detective',
      'Amateur Sleuth',
      'Cozy',
      'Women Sleuths',
    ]);
  });

  it('returns [] for missing or non-array categories', () => {
    expect(extractSubjects(undefined)).toEqual([]);
    expect(extractSubjects(null as unknown as string[])).toEqual([]);
  });

  it('caps runaway category lists', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Cat${i}`);
    expect(extractSubjects(many)).toHaveLength(12);
  });
});

describe('googleBooks lookup', () => {
  it('passes the key and the mandatory params, and trusts an ISBN hit verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { totalItems: 1, items: [VOLUME] }));
    // Deliberately mismatched title: an ISBN hit must NOT be verified.
    const book = makeBook({ isbn: '979-8-2172-6646-3', title: 'Totally Different Title' });

    const payload = await provider().lookup(book, fetchImpl as unknown as typeof fetch);

    expect(payload).not.toBeNull();
    expect(payload?.subjects).toContain('Cozy');
    expect(payload?.entities).toEqual([]);
    expect(payload?.raw).toEqual(VOLUME);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    // Punctuation stripped from the ISBN before querying.
    expect(url.searchParams.get('q')).toBe('isbn:9798217266463');
    expect(url.searchParams.get('key')).toBe('test-key');
    expect(url.searchParams.get('projection')).toBe('full');
    expect(url.searchParams.get('printType')).toBe('books');
    expect(url.searchParams.get('langRestrict')).toBe('en');
  });

  it('falls back to title/author search and verifies the match', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { totalItems: 1, items: [VOLUME] }));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);

    expect(payload?.subjects).toContain('Women Sleuths');
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.get('q')).toBe('intitle:"A Curiously Convenient Demise" inauthor:"Hannah Hendy"');
  });

  it('retries without the leading article when the exact phrase misses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 0, items: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 1, items: [VOLUME] }));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);

    expect(payload).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(second.searchParams.get('q')).toBe('intitle:"Curiously Convenient Demise" inauthor:"Hannah Hendy"');
  });

  it('returns null (not-found) when every candidate genuinely mismatches', async () => {
    const wrong = { id: 'x', volumeInfo: { title: 'An Entirely Different Book', authors: ['Someone Else'] } };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { totalItems: 1, items: [wrong] }));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('rejects a title match when the author disagrees', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { items: [VOLUME] }));
    const book = makeBook({ author: 'Someone Entirely Else' });

    await expect(provider().lookup(book, fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('throws a typed error on 429 naming the daily quota', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: { code: 429 } }));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(AppError);
    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/quota/i);
  });

  it('throws a typed error on 403 pointing at the key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, {}));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/API key/i);
  });

  it('redacts the API key from thrown messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/key=REDACTED/);
    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.not.toThrow(/test-key/);
  });

  it('surfaces the failure when every candidate errors at the transport level', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(AppError);
  });

  it('returns null without fetching when the book has no title', async () => {
    const fetchImpl = vi.fn();

    await expect(
      provider().lookup(makeBook({ title: '' }), fetchImpl as unknown as typeof fetch)
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
