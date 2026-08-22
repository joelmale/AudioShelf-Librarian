import { describe, expect, it, vi } from 'vitest';
import type { Book } from '../../types.js';
import { openLibraryProvider } from './openLibrary.js';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'It',
    author: 'Stephen King',
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
    isbn: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('openLibraryProvider', () => {
  it('has the stable provider name', () => {
    expect(openLibraryProvider.name).toBe('openlibrary');
  });

  it('queries by ISBN when present and maps entities/subjects, preserving raw', async () => {
    const doc = {
      key: '/works/OL1W',
      title: 'It',
      author_name: ['Stephen King'],
      person: ['Benjamin Hanscom', 'Beverly Marsh'],
      place: ['Derry', 'Maine'],
      time: ['1958'],
      subject: ['horror'],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 1, docs: [doc] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: '978-0-450-41143-9' });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toBe(
      'https://openlibrary.org/search.json?q=isbn%3A9780450411439&fields=key,title,author_name,person,place,time,subject&limit=1',
    );

    expect(result).not.toBeNull();
    expect(result?.raw).toEqual(doc);
    expect(result?.subjects).toEqual(['horror']);
    expect(result?.entities).toEqual(
      expect.arrayContaining([
        { entity: 'Benjamin Hanscom', kind: 'person' },
        { entity: 'Beverly Marsh', kind: 'person' },
        { entity: 'Derry', kind: 'place' },
        { entity: 'Maine', kind: 'place' },
        { entity: '1958', kind: 'time' },
      ]),
    );
    expect(result?.entities).toHaveLength(5);
  });

  it('skips the isbn query when the isbn is empty after stripping non-alphanumerics', async () => {
    const doc = { key: '/works/OL1W', title: 'It', author_name: ['Stephen King'] };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 1, docs: [doc] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: '---' });

    await openLibraryProvider.lookup(book, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain('q=title%3A%22It%22');
  });

  it('falls back to title/author search when there is no isbn, and accepts a verified match', async () => {
    const doc = { key: '/works/OL1W', title: 'It', author_name: ['Stephen King'], subject: ['horror'] };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 1, docs: [doc] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: null });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toBe(
      'https://openlibrary.org/search.json?q=title%3A%22It%22%20author%3A%22Stephen%20King%22&fields=key,title,author_name,person,place,time,subject&limit=3',
    );
    expect(result).not.toBeNull();
    expect(result?.raw).toEqual(doc);
  });

  it('returns null when the only candidate has a completely different title/author', async () => {
    const doc = { key: '/works/OL2W', title: 'A Totally Different Book', author_name: ['Someone Else'] };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 1, docs: [doc] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: null });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(result).toBeNull();
  });

  it('returns null when numFound is 0 and there is no isbn to fall back from', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 0, docs: [] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: null });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls through to the title/author query when the isbn search returns no docs (two fetch calls)', async () => {
    const doc = { key: '/works/OL1W', title: 'It', author_name: ['Stephen King'] };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('isbn%3A')) return jsonResponse(200, { numFound: 0, docs: [] });
      return jsonResponse(200, { numFound: 1, docs: [doc] });
    }) as unknown as typeof fetch;
    const book = makeBook({ isbn: '9780450411439' });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('isbn%3A9780450411439');
    expect(urls[1]).toContain('title%3A%22It%22');
    expect(result).not.toBeNull();
    expect(result?.raw).toEqual(doc);
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const book = makeBook({ isbn: '9780450411439' });

    await expect(openLibraryProvider.lookup(book, fetchImpl)).rejects.toThrow();
  });

  it('throws on an invalid JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const book = makeBook({ isbn: '9780450411439' });

    await expect(openLibraryProvider.lookup(book, fetchImpl)).rejects.toThrow();
  });

  it('dedupes entities case-insensitively within a kind', async () => {
    const doc = { key: '/works/OL1W', title: 'It', person: ['Pennywise', 'pennywise'] };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 1, docs: [doc] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: '9780450411439' });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(result?.entities).toEqual([{ entity: 'Pennywise', kind: 'person' }]);
  });

  it('returns null when the book has neither an isbn nor a title match target', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { numFound: 0, docs: [] })) as unknown as typeof fetch;
    const book = makeBook({ isbn: null, title: '' });

    const result = await openLibraryProvider.lookup(book, fetchImpl);

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
