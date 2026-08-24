/**
 * Audnexus enrichment provider (librarian engine plan §2).
 *
 * Audnexus (https://api.audnex.us) is an audiobook-native metadata aggregator
 * keyed by Audible ASIN. Pure fetch+parse: no DB access, no env vars, the
 * fetch implementation is injected so tests never touch the network (same
 * pattern as `recommendations.ts#verifyExternal` / `absClient.ts`).
 *
 * Contract:
 *  - No `book.asin` → null immediately, no request made (this provider cannot
 *    resolve the book at all).
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

const TIMEOUT_MS = 15_000;

interface AudnexusGenre {
  asin?: string;
  name?: string;
  type?: string;
}

interface AudnexusBookResponse {
  asin?: string;
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

export const audnexusProvider: EnrichmentProvider = {
  name: 'audnexus',

  async lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null> {
    const asin = book.asin?.trim();
    if (!asin) return null;

    const url = `https://api.audnex.us/books/${asin}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // Network down, DNS failure, or timeout.
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const message = isTimeout
        ? `Audnexus request to ${url} timed out after ${TIMEOUT_MS}ms`
        : `Could not reach Audnexus (${url})`;
      throw new AppError('INTERNAL', message, { cause: err });
    }

    if (res.status === 404) return null;

    if (!res.ok) {
      throw new AppError('INTERNAL', `Audnexus request to ${url} failed (HTTP ${res.status})`, {
        detail: { status: res.status },
      });
    }

    let raw: AudnexusBookResponse;
    try {
      raw = (await res.json()) as AudnexusBookResponse;
    } catch (err) {
      throw new AppError('INTERNAL', `Audnexus returned unparseable JSON for ${url}`, { cause: err });
    }

    return {
      raw,
      entities: [],
      subjects: extractSubjects(raw.genres),
    };
  },
};
