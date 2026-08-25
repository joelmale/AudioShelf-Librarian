/**
 * Google Books enrichment provider (librarian engine plan §2).
 *
 * Pure fetch+parse against the Books API v1 `volumes` endpoint — no DB
 * access, `fetchImpl` injected so tests never touch the network (the same
 * pattern as `openLibrary.ts` / `audnexus.ts`).
 *
 * Why this provider exists: Open Library's `person`/`place`/`time` fields come
 * from library-contributed MARC headings, which recent genre and indie fiction
 * simply does not have — a 2025/2026 audiobook resolves to a bare stub with
 * null subjects. Google Books carries BISAC categories and a real synopsis for
 * exactly those titles, plus an ISBN that can unblock Open Library's
 * trusted-verbatim ISBN path for the same book.
 *
 * API KEY REQUIRED. Per the Books API docs, a public-data request must still
 * "be accompanied by an identifier, such as an API key" (`key=` query param).
 * Unauthenticated calls are pooled into a shared anonymous Google project
 * whose per-day quota is routinely already exhausted, which surfaces as HTTP
 * 429 `RESOURCE_EXHAUSTED` on every request including simple volume-by-id
 * fetches. `createGoogleBooksProvider` therefore returns `null` when no key is
 * configured, and the caller omits the provider entirely — see the docblock on
 * that function for why omitting beats a null-returning provider.
 *
 * Lookup strategy (mirrors `openLibrary.ts`):
 *   1. `isbn:` search when the book has one — trusted verbatim, no match
 *      verification, since an ISBN hit is definitionally the right edition.
 *   2. `intitle:`/`inauthor:` search over `candidateTitlesFor`, tried in
 *      order, each verified via `matchesBook` before being accepted. One
 *      candidate's search failing at the transport level falls through to the
 *      next; if every candidate fails that way the last error is rethrown, so
 *      a real outage is cached as 'error' (retried sooner) rather than being
 *      silently downgraded to 'not-found'.
 */
import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import type { EnrichmentPayload, EnrichmentProvider } from '../types.js';
import { candidateTitlesFor, matchesBook } from './matching.js';
import {
  DEFAULT_HEADERS,
  GOOGLE_BOOKS_MIN_INTERVAL_MS,
  createRateLimiter,
  isRateLimited,
  markRateLimited,
  parseRetryAfter,
} from './throttle.js';

const VOLUMES_URL = 'https://www.googleapis.com/books/v1/volumes';
const TIMEOUT_MS = 15_000;

/** Module-scoped: throttles across the whole concurrent book pool, not per book. */
const limiter = createRateLimiter(GOOGLE_BOOKS_MIN_INTERVAL_MS);

/**
 * Hard cap on title searches per book. `candidateTitlesFor` can legitimately
 * return several variants, but Google Books bills a per-DAY quota — an
 * uncapped loop lets a handful of awkward filenames eat the allowance the rest
 * of the library needs. The ISBN probe is not counted against this.
 */
const MAX_TITLE_ATTEMPTS = 3;

/**
 * Google Books serves frequent transient 503s: a sample of 8 identical live
 * calls returned 2 successes first try, 4 that succeeded only after a retry,
 * and 2 that still failed after four attempts. Without retrying, the majority
 * of a real run would cache status 'error' for books the API can actually
 * resolve. Backoff is 400ms * 2^n between attempts, and every attempt still
 * passes through the shared limiter.
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `projection=lite` omits `categories` and `description` outright, so `full`
 *  is mandatory. `printType=books` drops magazine hits.
 *
 *  `langRestrict=en` is a RANKING hint, not a filter — verified against the
 *  live API, which still returns `lang: 'fr'` editions alongside the English
 *  one. It is kept because the English edition does rank first with it, but it
 *  must never be relied on to exclude a translation; `matchesBook` is what
 *  actually guards correctness. */
const BASE_PARAMS: Readonly<Record<string, string>> = {
  printType: 'books',
  projection: 'full',
  langRestrict: 'en',
};

export interface GoogleBooksVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  categories?: string[];
  pageCount?: number;
  industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  [key: string]: unknown;
}

interface GoogleBooksVolume {
  id?: string;
  volumeInfo?: GoogleBooksVolumeInfo;
}

interface GoogleBooksResponse {
  totalItems?: number;
  items?: GoogleBooksVolume[];
}

function buildUrl(query: string, apiKey: string, maxResults: number): string {
  const params = new URLSearchParams({ ...BASE_PARAMS, q: query, maxResults: String(maxResults), key: apiKey });
  return `${VOLUMES_URL}?${params.toString()}`;
}

/**
 * `url` is included in thrown messages for debuggability but the API key is
 * redacted first — enrichment errors land in the action log and `sync_log`,
 * which are user-visible surfaces.
 */
function redact(url: string): string {
  return url.replace(/([?&]key=)[^&]*/, '$1REDACTED');
}

/**
 * One HTTP attempt. Separated from the retry loop so the loop can decide,
 * per status, whether another attempt is worth making.
 */
async function attempt(fetchImpl: typeof fetch, url: string): Promise<Response> {
  await limiter.acquire();
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...DEFAULT_HEADERS } });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const message = isTimeout
      ? `Google Books request timed out after ${TIMEOUT_MS}ms: ${redact(url)}`
      : `Could not reach Google Books: ${redact(url)}`;
    throw new AppError('INTERNAL', message, { cause: err });
  }
}

async function request<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  let response!: Response;

  for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
    response = await attempt(fetchImpl, url);

    // Called out separately because it is the failure mode this provider is
    // most likely to hit, and "429" alone sends you looking at your own
    // request rate rather than at a per-DAY project quota. Never retried:
    // a quota is not going to clear in a few hundred milliseconds.
    if (response.status === 429) {
      limiter.penalize(parseRetryAfter(response.headers?.get?.('retry-after')) ?? 60_000);
      throw markRateLimited(
        new AppError('INTERNAL', 'Google Books quota exhausted (HTTP 429) — check the daily quota for the project owning GOOGLE_BOOKS_API_KEY', {
          detail: { status: 429, url: redact(url) },
        })
      );
    }
    if (response.status === 403) {
      limiter.penalize(60_000);
      throw markRateLimited(
        new AppError('INTERNAL', 'Google Books rejected the API key (HTTP 403) — confirm the Books API is enabled and any key restrictions allow this caller', {
          detail: { status: 403, url: redact(url) },
        })
      );
    }

    if (!RETRY_STATUSES.has(response.status)) break;
    if (n < MAX_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** n);
  }

  if (!response.ok) {
    throw new AppError('INTERNAL', `Google Books returned ${response.status} for ${redact(url)}`, {
      detail: { status: response.status, url: redact(url) },
    });
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new AppError('INTERNAL', `Google Books returned an unparseable response for ${redact(url)}`, { cause: err });
  }
}

const runSearch = (fetchImpl: typeof fetch, url: string): Promise<GoogleBooksResponse> =>
  request<GoogleBooksResponse>(fetchImpl, url);

/**
 * Re-fetch a matched volume by id.
 *
 * Search results are ABRIDGED even under `projection=full`: the search hit for
 * Brynne Weaver's *Harvest Season* carries `categories: ["Fiction"]`, while
 * fetching the same volume by id returns six BISAC paths — "Dark Romance",
 * "Enemies to Lovers", "Small Town & Rural" — and a description four times
 * longer. Those specific terms are the whole point of this provider, so one
 * extra request per MATCHED book (not per candidate searched) is worth it.
 *
 * Best-effort: any failure returns null and the caller keeps the search hit,
 * because a thin payload beats no payload. A rate-limit error still propagates
 * — that one must never be swallowed.
 */
async function hydrate(fetchImpl: typeof fetch, volume: GoogleBooksVolume, apiKey: string): Promise<GoogleBooksVolume | null> {
  if (!volume.id) return null;
  const params = new URLSearchParams({ key: apiKey });
  try {
    const full = await request<GoogleBooksVolume>(fetchImpl, `${VOLUMES_URL}/${volume.id}?${params.toString()}`);
    return full?.volumeInfo ? full : null;
  } catch (err) {
    if (isRateLimited(err)) throw err;
    return null;
  }
}

/**
 * BISAC categories arrive as slash-delimited paths
 * ("Fiction / Mystery & Detective / Cozy / General"). Emit each segment as its
 * own facet term — "Cozy" and "Women Sleuths" are what the tagger can ground
 * against, whereas the full path matches nothing.
 *
 * "General" is dropped as a pure-noise leaf ("Fiction / ... / General" says
 * only that the publisher declined to subcategorize). Deduped
 * case-insensitively, first spelling wins, capped to keep one over-categorized
 * volume from crowding out the other providers' subjects downstream.
 */
export function extractSubjects(categories: string[] | undefined): string[] {
  if (!Array.isArray(categories)) return [];
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const category of categories) {
    if (typeof category !== 'string') continue;
    for (const segment of category.split('/')) {
      const term = segment.trim();
      if (!term || term.toLowerCase() === 'general') continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      subjects.push(term);
    }
  }
  return subjects.slice(0, 12);
}

/**
 * `entities` is intentionally empty: the Books API exposes no structured
 * person/place/time fields. The named entities for these books live in the
 * synopsis prose, and extracting them is the description-extractor's job —
 * the whole `EnrichmentPayload` is cached verbatim (see `enricher.ts`), so a
 * later extractor run reads `raw.volumeInfo.description` without re-fetching.
 */
function toPayload(volume: GoogleBooksVolume): EnrichmentPayload {
  return {
    raw: volume,
    entities: [],
    subjects: extractSubjects(volume.volumeInfo?.categories),
  };
}

function firstVolume(response: GoogleBooksResponse): GoogleBooksVolume | undefined {
  return (response.items ?? []).find((item) => item?.volumeInfo);
}

/**
 * Build the provider, or `null` when no API key is configured.
 *
 * Returning `null` here (and having the caller omit the provider) rather than
 * shipping a provider whose `lookup` returns null without a key: a
 * null-returning lookup would cache status 'not-found' for every book, which
 * is both untrue — we never asked — and sticky, since 'not-found' carries a
 * 30-day TTL. Adding a key later would then need a `refresh: true` run to
 * re-check the whole library. An absent provider writes no rows at all, so the
 * day a key appears every book is naturally a fresh candidate.
 */
export function createGoogleBooksProvider(apiKey: string | undefined | null): EnrichmentProvider | null {
  const key = apiKey?.trim();
  if (!key) return null;

  return {
    name: 'googlebooks',

    async lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null> {
      const isbn = book.isbn ? book.isbn.replace(/[^a-zA-Z0-9]/g, '') : '';
      if (isbn) {
        const volume = firstVolume(await runSearch(fetchImpl, buildUrl(`isbn:${isbn}`, key, 1)));
        if (volume) return toPayload((await hydrate(fetchImpl, volume, key)) ?? volume);
      }

      if (!book.title) return null;

      let lastError: unknown = null;
      let anySucceeded = false;
      for (const title of candidateTitlesFor(book).slice(0, MAX_TITLE_ATTEMPTS)) {
        const parts = [`intitle:"${title}"`];
        if (book.author) parts.push(`inauthor:"${book.author}"`);

        let response: GoogleBooksResponse;
        try {
          response = await runSearch(fetchImpl, buildUrl(parts.join(' '), key, 5));
        } catch (err) {
          // A quota/rate response means stop asking — trying the next candidate
          // is exactly how a throttle escalates into a block.
          if (isRateLimited(err)) throw err;
          // Any other transport failure: try the next candidate.
          lastError = err;
          continue;
        }
        anySucceeded = true;

        const match = (response.items ?? []).find((item) =>
          item?.volumeInfo
            ? matchesBook(
                { title: item.volumeInfo.title, authors: item.volumeInfo.authors },
                title,
                book
              )
            : false
        );
        if (match) return toPayload((await hydrate(fetchImpl, match, key)) ?? match);
      }

      // Every candidate failed at the transport level (none merely mismatched)
      // — surface it rather than caching 'not-found' for what was an outage.
      if (!anySucceeded && lastError) throw lastError;
      return null;
    },
  };
}
