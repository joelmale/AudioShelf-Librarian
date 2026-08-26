import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import { createGoogleBooksProvider, extractSubjects } from './googleBooks.js';
import { isQuotaExhausted, isRateLimited } from './throttle.js';

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
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** Verbatim shape of a real per-day quota 429 from books.googleapis.com. */
const DAILY_QUOTA_BODY = {
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'books.googleapis.com' for consumer 'project_number:624717413613'.",
    status: 'RESOURCE_EXHAUSTED',
  },
};

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

  // All of the following are verbatim from a real 43-book sample run.
  it('splits comma-delimited MARC headings that the slash-only splitter missed', () => {
    expect(extractSubjects(['Fiction, science fiction, general'])).toEqual(['Fiction', 'Science Fiction']);
    expect(extractSubjects(['Fiction, general'])).toEqual(['Fiction']);
    expect(extractSubjects(['Fiction, fantasy, historical'])).toEqual(['Fiction', 'Fantasy', 'Historical']);
  });

  it('does NOT split a compound BISAC leaf whose comma is part of the term', () => {
    // From 20,000 Leagues. Splitting this on the comma would shred a real leaf.
    expect(extractSubjects(['Boats, Ships & Underwater Craft'])).toEqual(['Boats, Ships & Underwater Craft']);
    expect(extractSubjects(['occult & supernatural fiction'])).toEqual(['Occult & Supernatural Fiction']);
  });

  it('drops machine tags', () => {
    expect(extractSubjects(['nyt:trade_fiction_paperback=2011-12-31'])).toEqual([]);
    // A colon alone is not enough — real headings use them.
    expect(extractSubjects(['Fiction: Horror'])).toEqual(['Fiction: Horror']);
  });

  it('title-cases lowercase headings so dedup picks one spelling', () => {
    expect(extractSubjects(['Fiction / Fantasy', 'fiction, fantasy'])).toEqual(['Fiction', 'Fantasy']);
  });

  it('drops "general" however it is delimited', () => {
    expect(extractSubjects(['Fiction / Mystery & Detective / Cozy / General'])).toEqual([
      'Fiction',
      'Mystery & Detective',
      'Cozy',
    ]);
  });
});

describe('googleBooks lookup', () => {
  it('passes the key and the mandatory params, and trusts an ISBN hit verbatim', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 1, items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));
    // Deliberately mismatched title: an ISBN hit must NOT be verified.
    const book = makeBook({ isbn: '979-8-2172-6646-3', title: 'Totally Different Title' });

    const payload = await provider().lookup(book, fetchImpl as unknown as typeof fetch);

    expect(payload).not.toBeNull();
    expect(payload?.subjects).toContain('Cozy');
    expect(payload?.entities).toEqual([]);
    expect(payload?.raw).toEqual(VOLUME);

    // One search + one hydrate-by-id.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain(`/volumes/${VOLUME.id}?`);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    // Punctuation stripped from the ISBN before querying.
    expect(url.searchParams.get('q')).toBe('isbn:9798217266463');
    expect(url.searchParams.get('key')).toBe('test-key');
    expect(url.searchParams.get('projection')).toBe('full');
    expect(url.searchParams.get('printType')).toBe('books');
    expect(url.searchParams.get('langRestrict')).toBe('en');
  });

  it('falls back to title/author search and verifies the match', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 1, items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);

    expect(payload?.subjects).toContain('Women Sleuths');
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.get('q')).toBe('intitle:"A Curiously Convenient Demise" inauthor:"Hannah Hendy"');
  });

  // Plan order for this book is: [1] title+author, [2] title alone,
  // [3] article-stripped title+author, [4] article-stripped title alone.
  it('retries without the leading article when the exact phrase misses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 0, items: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 0, items: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 1, items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);

    expect(payload).not.toBeNull();
    const third = new URL(fetchImpl.mock.calls[2][0] as string);
    expect(third.searchParams.get('q')).toBe('intitle:"Curiously Convenient Demise" inauthor:"Hannah Hendy"');
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

  // 429 is retried: live testing showed it is usually a short-window burst
  // limit that clears in seconds, not the per-day quota.
  it('retries a 429 and succeeds when the burst window clears', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(payload).not.toBeNull();
  });

  it('gives up on a persistent 429 and marks it rate-limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: { code: 429 } }));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(AppError);
    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/rate limit/i);
  });

  // Google returns 429 for two conditions the status code cannot separate:
  // a short burst limit (retry) and the per-day quota (fatal for the run).
  it('treats a "Queries per day" 429 as fatal and does not retry it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, DAILY_QUOTA_BODY));

    await expect(
      provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/daily quota/i);
    // One call: no retries, no walking the rest of the query plan.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks a daily-quota error as quota-exhausted, not merely rate-limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, DAILY_QUOTA_BODY));

    const err = await provider()
      .lookup(makeBook(), fetchImpl as unknown as typeof fetch)
      .then(() => null, (e: unknown) => e);

    expect(isQuotaExhausted(err)).toBe(true);
    // Still rate-limited too, so existing abort paths keep working.
    expect(isRateLimited(err)).toBe(true);
  });

  it('does NOT treat an unrecognised 429 body as the daily quota', async () => {
    // Safe default: an unknown 429 is retried as a burst. Wrongly retrying a
    // daily quota costs four requests; wrongly aborting would abandon the run.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: { message: 'Too many requests' } }));

    const err = await provider()
      .lookup(makeBook(), fetchImpl as unknown as typeof fetch)
      .then(() => null, (e: unknown) => e);

    expect(isQuotaExhausted(err)).toBe(false);
    expect(isRateLimited(err)).toBe(true);
  });

  it('throws a typed error on 403 pointing at the key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, {}));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/API key/i);
  });

  // 404 rather than 500: 5xx is retried with backoff, which would just make
  // this test slow without exercising anything extra.
  it('redacts the API key from thrown messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/key=REDACTED/);
    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.not.toThrow(/test-key/);
  });

  it('does not retry a 4xx that is not 429/403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(AppError);
    // 2 candidate titles x (with author, without author) = 4 planned queries,
    // one attempt each — no retries on a 404.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('surfaces the failure when every candidate errors at the transport level', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(AppError);
  });

  it('retries a transient 503 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 1, items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(payload).not.toBeNull();
  }, 20_000);

  it('stops the whole query plan once 429s persist — never walks the plan while throttled', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, {}));

    await expect(provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(/rate limit/i);
    // 4 attempts on the FIRST query, then abort — not 4 attempts x 4 planned
    // queries. Continuing the plan while throttled is how a limit becomes a ban.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('prefers the hydrated volume, whose categories are richer than the search hit', async () => {
    const thin = { id: 'v1', volumeInfo: { title: 'A Curiously Convenient Demise', authors: ['Hannah Hendy'], categories: ['Fiction'] } };
    const full = { id: 'v1', volumeInfo: { ...thin.volumeInfo, categories: ['Fiction / Romance / Dark Romance', 'Fiction / Romance / Enemies to Lovers'] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { items: [thin] }))
      .mockResolvedValueOnce(jsonResponse(200, full));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(payload?.subjects).toContain('Dark Romance');
    expect(payload?.subjects).toContain('Enemies to Lovers');
  });

  it('keeps the search hit when hydration fails — a thin payload beats none', async () => {
    const thin = { id: 'v1', volumeInfo: { title: 'A Curiously Convenient Demise', authors: ['Hannah Hendy'], categories: ['Fiction'] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { items: [thin] }))
      .mockResolvedValue(jsonResponse(503, {}));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);
    expect(payload?.subjects).toEqual(['Fiction']);
  }, 20_000);

  // Regression: a bare `await` on the ISBN probe meant a 503 there aborted the
  // whole lookup before the title fallback ran. A real run produced a stream of
  // `Provider "googlebooks" failed ... 503 ... q=isbn%3A...` for books whose
  // title search would have resolved.
  it('falls back to title search when the ISBN probe 503s', async () => {
    const fetchImpl = vi
      .fn()
      // ISBN probe: 503 on all four attempts.
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      // Title search then succeeds, and hydrates.
      .mockResolvedValueOnce(jsonResponse(200, { items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    const payload = await provider().lookup(
      makeBook({ isbn: '9798217266463' }),
      fetchImpl as unknown as typeof fetch
    );

    expect(payload).not.toBeNull();
    expect(payload?.subjects).toContain('Cozy');
    // The fifth call is the title search — proof we did not abort at the ISBN.
    const fifth = new URL(fetchImpl.mock.calls[4][0] as string);
    expect(fifth.searchParams.get('q')).toContain('intitle:');
  }, 30_000);

  it('still aborts on a rate-limit at the ISBN probe — no fallback hammering', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, {}));

    await expect(
      provider().lookup(makeBook({ isbn: '9798217266463' }), fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/rate limit/i);
    // Retries the ISBN probe, then aborts — no title fallback while throttled.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('reports error, not not-found, when the ISBN probe failed and the title search merely missed', async () => {
    const wrong = { id: 'x', volumeInfo: { title: 'Something Else', authors: ['Nobody'] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValue(jsonResponse(200, { items: [wrong] }));

    // Caching 'not-found' here would claim we completed a check we never did.
    await expect(
      provider().lookup(makeBook({ isbn: '9798217266463' }), fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/503/);
  }, 30_000);

  it('retries without the author constraint when the strict query misses', async () => {
    const fetchImpl = vi
      .fn()
      // intitle + inauthor -> nothing
      .mockResolvedValueOnce(jsonResponse(200, { totalItems: 0, items: [] }))
      // intitle alone -> the book
      .mockResolvedValueOnce(jsonResponse(200, { items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    const payload = await provider().lookup(makeBook(), fetchImpl as unknown as typeof fetch);

    expect(payload).not.toBeNull();
    const first = new URL(fetchImpl.mock.calls[0][0] as string).searchParams.get('q');
    const second = new URL(fetchImpl.mock.calls[1][0] as string).searchParams.get('q');
    expect(first).toContain('inauthor:');
    expect(second).not.toContain('inauthor:');
    expect(second).toContain('intitle:"A Curiously Convenient Demise"');
  });

  it('de-inverts a "Last, First" author in the query', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { items: [VOLUME] }))
      .mockResolvedValueOnce(jsonResponse(200, VOLUME));

    await provider().lookup(
      makeBook({ author: 'Hendy, Hannah' }),
      fetchImpl as unknown as typeof fetch
    );

    const q = new URL(fetchImpl.mock.calls[0][0] as string).searchParams.get('q');
    expect(q).toContain('inauthor:"Hannah Hendy"');
  });

  it('caps the number of searches even with many candidates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { totalItems: 0, items: [] }));

    await provider().lookup(
      makeBook({ title: 'Green, Simon R. - Deathstalker 05 - Deathstalker Legacy', author: 'Simon R. Green' }),
      fetchImpl as unknown as typeof fetch
    );

    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('returns null without fetching when the book has no title', async () => {
    const fetchImpl = vi.fn();

    await expect(
      provider().lookup(makeBook({ title: '' }), fetchImpl as unknown as typeof fetch)
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
