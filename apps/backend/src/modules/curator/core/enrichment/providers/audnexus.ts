/**
 * Audnexus enrichment provider (librarian engine plan §2).
 *
 * Audnexus (https://api.audnex.us) is an audiobook-native metadata aggregator
 * keyed by Audible ASIN. Pure fetch+parse: no DB access, no env vars, the
 * fetch implementation is injected so tests never touch the network (same
 * pattern as `recommendations.ts#verifyExternal` / `absClient.ts`).
 *
 * Contract:
 *  - No `book.asin` → fall back to `GET /books/search?q=` (title + author) and
 *    verify the hit before accepting it. Audiobookshelf only populates `asin`
 *    when it matched an item against Audible, so an ASIN-only provider silently
 *    skipped every unmatched book — including titles Audnexus knows perfectly
 *    well. `/books/search` returns `[]` for no match and 400 only for an empty
 *    `q`, so it maps cleanly onto the not-found/error split below.
 *  - HTTP 404 → null (unknown ASIN; cached as 'not-found').
 *  - Any other non-2xx, a network failure, or a JSON parse failure → throw a
 *    typed AppError (cached as 'error' and retried sooner than 'not-found').
 *  - Success → raw payload verbatim, no entities (Audnexus has no
 *    character/place data), and subjects built from genres[] of both
 *    type:'genre' and type:'tag', deduped case-insensitively.
 */
import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import type { EnrichmentPayload, EnrichmentProvider } from '../types.js';
import { candidateTitlesFor, deinvertAuthor, matchesBook } from './matching.js';
import {
  AUDNEXUS_MIN_INTERVAL_MS,
  DEFAULT_HEADERS,
  createRateLimiter,
  isRateLimited,
  markRateLimited,
  parseRetryAfter,
} from './throttle.js';

const TIMEOUT_MS = 15_000;

/** Module-scoped so it throttles across the whole concurrent book pool.
 *  Audnexus is a small community-run service with no paid tier. */
const limiter = createRateLimiter(AUDNEXUS_MIN_INTERVAL_MS);

/** Cap search variants per book; each candidate is a full search request. */
const MAX_TITLE_ATTEMPTS = 3;

interface AudnexusGenre {
  asin?: string;
  name?: string;
  type?: string;
}

interface AudnexusBookResponse {
  asin?: string;
  title?: string;
  authors?: Array<{ name?: string }>;
  description?: string;
  genres?: AudnexusGenre[];
  narrators?: Array<{ name?: string }>;
  runtimeLengthMin?: number;
  rating?: string;
  releaseDate?: string;
  [key: string]: unknown;
}

/** genres[] holds both broad `type:'genre'` and narrower `type:'tag'` entries;
 *  both map to subjects, deduped case-insensitively, blanks skipped. */
function extractSubjects(genres: AudnexusGenre[] | undefined): string[] {
  if (!Array.isArray(genres)) return [];
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const genre of genres) {
    if (genre.type !== 'genre' && genre.type !== 'tag') continue;
    const name = genre.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    subjects.push(name);
  }
  return subjects;
}

/** Shared request+parse for both the by-ASIN and by-search endpoints. Returns
 *  `null` on 404 (unknown ASIN); throws for transport, non-2xx, and parse
 *  failures so they cache as 'error' and are retried sooner than 'not-found'. */
async function getJson<T>(fetchImpl: typeof fetch, url: string, label: string): Promise<T | null> {
  await limiter.acquire();

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...DEFAULT_HEADERS } });
  } catch (err) {
    // Network down, DNS failure, or timeout.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const message = isTimeout
      ? `Audnexus ${label} request to ${url} timed out after ${TIMEOUT_MS}ms`
      : `Could not reach Audnexus (${url})`;
    throw new AppError('INTERNAL', message, { cause: err });
  }

  if (res.status === 404) return null;

  if (res.status === 429 || res.status === 503) {
    limiter.penalize(parseRetryAfter(res.headers?.get?.('retry-after')) ?? 60_000);
    throw markRateLimited(
      new AppError('INTERNAL', `Audnexus is throttling us (HTTP ${res.status}) — backing off`, {
        detail: { status: res.status },
      })
    );
  }

  if (!res.ok) {
    throw new AppError('INTERNAL', `Audnexus ${label} request to ${url} failed (HTTP ${res.status})`, {
      detail: { status: res.status },
    });
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new AppError('INTERNAL', `Audnexus returned unparseable JSON for ${url}`, { cause: err });
  }
}

function toPayload(raw: AudnexusBookResponse): EnrichmentPayload {
  return {
    raw,
    entities: [],
    subjects: extractSubjects(raw.genres),
  };
}

export const audnexusProvider: EnrichmentProvider = {
  name: 'audnexus',

  /** `raw.description` verbatim (uncleaned) — see
   *  `EnrichmentProvider.extractDescription`. */
  extractDescription(raw: unknown) {
    if (!raw || typeof raw !== 'object') return null;
    const description = (raw as AudnexusBookResponse).description;
    return typeof description === 'string' ? description : null;
  },

  async lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null> {
    // 1. ASIN is definitionally the right edition — trusted verbatim.
    const asin = book.asin?.trim();
    if (asin) {
      const raw = await getJson<AudnexusBookResponse>(fetchImpl, `https://api.audnex.us/books/${asin}`, 'book');
      if (raw) return toPayload(raw);
    }

    if (!book.title) return null;

    // 2. Search by title (+author), verifying each hit. Unlike the ASIN path
    //    this can return the wrong book, so `matchesBook` gates every result.
    let lastError: unknown = null;
    let anySucceeded = false;
    for (const title of candidateTitlesFor(book).slice(0, MAX_TITLE_ATTEMPTS)) {
      const q = book.author ? `${title} ${deinvertAuthor(book.author)}` : title;
      const url = `https://api.audnex.us/books/search?q=${encodeURIComponent(q)}`;

      let results: AudnexusBookResponse[] | null;
      try {
        results = await getJson<AudnexusBookResponse[]>(fetchImpl, url, 'search');
      } catch (err) {
        // A throttle response means stop asking immediately.
        if (isRateLimited(err)) throw err;
        // This candidate's search failed outright — try the next.
        lastError = err;
        continue;
      }
      anySucceeded = true;
      if (!Array.isArray(results)) continue;

      const match = results.find((r) =>
        matchesBook({ title: r?.title, authors: (r?.authors ?? []).map((a) => a?.name ?? '') }, title, book)
      );
      if (match) return toPayload(match);
    }

    // Every candidate failed at the transport level (none merely mismatched) —
    // surface it rather than caching 'not-found' for what was an outage.
    if (!anySucceeded && lastError) throw lastError;
    return null;
  },
};
