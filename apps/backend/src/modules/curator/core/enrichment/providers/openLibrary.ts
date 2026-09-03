/**
 * Open Library enrichment provider (librarian engine plan §2).
 *
 * Pure fetch+parse against openlibrary.org's search API — no DB access, no
 * env vars, `fetchImpl` injected so it is testable with fixture responses
 * (the same pattern as `recommendations.ts#verifyExternal`).
 *
 * Lookup strategy:
 *   1. ISBN search, when the book has one — trusted verbatim (no match
 *      verification), since an ISBN hit is definitionally the right edition.
 *   2. Title/author search over `titleParse`'s `candidateTitles`, tried in
 *      order, falling back to the raw `book.title` — each attempt is
 *      verified against the book's normalized title/author before being
 *      accepted (see `matchesBook`). Verification is what makes trying
 *      multiple candidates safe: a wrong candidate simply fails to match and
 *      the next one is tried, rather than a false positive being cached. A
 *      book already carrying a `title_parse` uses it; otherwise `parseTitle`
 *      is called inline, so this provider benefits even before a title-parse
 *      run has touched the book. One candidate's search failing outright
 *      (e.g. a transient 404/500) falls through to the next candidate rather
 *      than aborting the whole lookup — but if every candidate's search
 *      fails that way, the last failure is still thrown, preserving the
 *      provider contract that a real transport failure is cached as 'error'
 *      (retried sooner) rather than silently downgraded to 'not-found'.
 */
import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
import type { EnrichedEntity, EnrichmentPayload, EnrichmentProvider, EntityKind } from '../types.js';
import { candidateTitlesFor, deinvertAuthor, matchesBook } from './matching.js';
import {
  DEFAULT_HEADERS,
  OPEN_LIBRARY_MIN_INTERVAL_MS,
  createRateLimiter,
  isRateLimited,
  markRateLimited,
  parseRetryAfter,
} from './throttle.js';

const SEARCH_URL = 'https://openlibrary.org/search.json';
const FIELDS = 'key,title,author_name,person,place,time,subject';
const TIMEOUT_MS = 15_000;

/** Module-scoped so it throttles across the whole concurrent book pool. Open
 *  Library serves an expensive Solr search on donated infrastructure and is
 *  the likeliest of our providers to block a bulk consumer — 1 req/s. */
const limiter = createRateLimiter(OPEN_LIBRARY_MIN_INTERVAL_MS);

/** Cap title variants per book; `candidateTitlesFor` may return several and
 *  each is a full search. */
const MAX_TITLE_ATTEMPTS = 3;

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  person?: string[];
  place?: string[];
  time?: string[];
  subject?: string[];
}

interface OpenLibrarySearchResponse {
  numFound: number;
  docs: OpenLibraryDoc[];
}

async function runSearch(fetchImpl: typeof fetch, url: string): Promise<OpenLibrarySearchResponse> {
  await limiter.acquire();

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...DEFAULT_HEADERS } });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const message = isTimeout
      ? `Open Library request timed out after ${TIMEOUT_MS}ms: ${url}`
      : `Could not reach Open Library: ${url}`;
    throw new AppError('INTERNAL', message, { cause: err });
  }
  if (response.status === 429 || response.status === 503) {
    // Back off the whole pool and stop trying further candidates for this
    // book — continuing to search after a throttle is what turns it into a ban.
    limiter.penalize(parseRetryAfter(response.headers?.get?.('retry-after')) ?? 60_000);
    throw markRateLimited(
      new AppError('INTERNAL', `Open Library is throttling us (HTTP ${response.status}) — backing off`, {
        detail: { status: response.status, url },
      })
    );
  }
  if (!response.ok) {
    throw new AppError('INTERNAL', `Open Library returned ${response.status} for ${url}`, {
      detail: { status: response.status, url },
    });
  }
  try {
    return (await response.json()) as OpenLibrarySearchResponse;
  } catch (err) {
    throw new AppError('INTERNAL', `Open Library returned an unparseable response for ${url}`, { cause: err });
  }
}

function isbnSearchUrl(isbn: string): string {
  return `${SEARCH_URL}?q=isbn%3A${isbn}&fields=${FIELDS}&limit=1`;
}

function titleAuthorSearchUrl(title: string, author: string | null): string {
  const parts = [`title:"${title}"`];
  // De-inverted — see `deinvertAuthor`. Catalogues index the natural order.
  if (author) parts.push(`author:"${deinvertAuthor(author)}"`);
  return `${SEARCH_URL}?q=${encodeURIComponent(parts.join(' '))}&fields=${FIELDS}&limit=3`;
}

/**
 * Strip MARC heading qualifiers that carry no identity.
 *
 * Open Library's `person`/`place`/`time` fields come from MARC subject
 * headings, which disambiguate with a trailing parenthetical. Two kinds of
 * those qualifiers are pure cataloguing metadata — a type label
 * ("Dios (Fictitious character)", "Arrakis (Planet)") and a life span
 * ("Shakespeare, William (1564-1616)") — and storing them verbatim actively
 * breaks the allowlist this data exists to be. `entityMatcher.normalizeTokens`
 * turns the qualifier into real tokens, so a tagger proposing "Dios" fails the
 * exact match against ["dios","fictitious","character"], and the repair path
 * only runs for multi-token candidates. `ground.ts#groundCharacter` then sees a
 * non-empty person allowlist and drops the tag as a hallucination — the
 * allowlist rejecting the very character it was built from.
 *
 * Deliberately NARROW. A census of this library's 3,504 stored entities found
 * 79 trailing parentheticals, and most are NOT safe to remove: nicknames
 * ("Umber, Jon (the Greatjon)", "Frey, Walder (Black Walder)") are identity and
 * distinguish people who share a surname, and geographic qualifiers
 * ("Key West (Fla.)") distinguish same-named places. Stripping those would
 * merge distinct entities — a worse failure than the one being fixed. Only the
 * two classes above are removed, and only when something is left behind.
 */
const MARC_TYPE_QUALIFIER =
  /\s*\([^)]*\b(?:fictitious|fictional|imaginary|legendary|mythical|mythological|biblical|spirit|deity|planet)\b[^)]*\)\s*$/i;
/** A parenthetical that is nothing but a life span or a single year. */
const MARC_DATE_QUALIFIER = /\s*\(\s*(?:b\.|d\.|fl\.|ca\.|circa)?\s*\d{3,4}\??\s*(?:[-–—]\s*(?:\d{3,4}\??)?)?\s*\)\s*$/;

export function stripMarcQualifier(heading: string): string {
  let out = heading.trim();
  for (const pattern of [MARC_TYPE_QUALIFIER, MARC_DATE_QUALIFIER]) {
    const stripped = out.replace(pattern, '').trim();
    // Never strip a heading away to nothing: a `time` entity really can be
    // just a date, and an empty entity is worse than a qualified one.
    if (stripped !== '') out = stripped;
  }
  return out;
}

function pushEntities(entities: EnrichedEntity[], seen: Set<string>, values: string[] | undefined, kind: EntityKind): void {
  for (const value of values ?? []) {
    // Strip before de-duping: "Dracula (Fictional character)" and a bare
    // "Dracula" in the same doc must collapse to one entity, not two.
    const trimmed = stripMarcQualifier(value);
    if (!trimmed) continue;
    const key = `${kind}:${trimmed.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ entity: trimmed, kind });
  }
}

function toPayload(doc: OpenLibraryDoc): EnrichmentPayload {
  const entities: EnrichedEntity[] = [];
  const seen = new Set<string>();
  pushEntities(entities, seen, doc.person, 'person');
  pushEntities(entities, seen, doc.place, 'place');
  pushEntities(entities, seen, doc.time, 'time');
  return {
    raw: doc,
    entities,
    subjects: doc.subject ?? [],
  };
}

export const openLibraryProvider: EnrichmentProvider = {
  name: 'openlibrary',

  async lookup(book: Book, fetchImpl: typeof fetch): Promise<EnrichmentPayload | null> {
    // Best-effort, for the same reason as `googleBooks.ts`: a bare await here
    // let a transient failure on the ISBN probe abort the lookup before the
    // title/author fallback ever ran.
    const isbn = book.isbn ? book.isbn.replace(/[^a-zA-Z0-9]/g, '') : '';
    let isbnError: unknown = null;
    if (isbn) {
      try {
        const isbnResult = await runSearch(fetchImpl, isbnSearchUrl(isbn));
        const [doc] = isbnResult.docs;
        if (doc) return toPayload(doc);
      } catch (err) {
        if (isRateLimited(err)) throw err;
        isbnError = err;
      }
    }

    if (!book.title) {
      if (isbnError) throw isbnError;
      return null;
    }

    let lastError: unknown = null;
    let anySucceeded = false;
    for (const title of candidateTitlesFor(book).slice(0, MAX_TITLE_ATTEMPTS)) {
      let titleResult: OpenLibrarySearchResponse;
      try {
        titleResult = await runSearch(fetchImpl, titleAuthorSearchUrl(title, book.author));
      } catch (err) {
        // A throttle response means stop asking immediately.
        if (isRateLimited(err)) throw err;
        // This candidate's search failed outright (e.g. a transient 404/500)
        // — try the next candidate rather than aborting the whole lookup.
        lastError = err;
        continue;
      }
      anySucceeded = true;
      const match = titleResult.docs.find((doc) =>
        matchesBook({ title: doc.title, authors: doc.author_name }, title, book)
      );
      if (match) return toPayload(match);
    }

    // Every candidate's search failed at the transport/parse level (none
    // merely mismatched) — surface the failure rather than silently caching
    // 'not-found' for what was actually an outage.
    if (!anySucceeded && lastError) throw lastError;
    // Title search answered, but the authoritative ISBN check never completed.
    if (isbnError) throw isbnError;
    return null;
  },

  /**
   * Re-extract entities and subjects from the cached doc. No network.
   *
   * Safe here in a way it was NOT for Hardcover. `toPayload` stores the single
   * `matchesBook`-verified doc as `raw`, so there is no ambiguity to resolve
   * and nothing to guess: re-deriving reads exactly the document the original
   * lookup accepted. Hardcover's hook had to be removed because its `raw` is a
   * whole unverified search page and re-deriving picked `hits[0]`, silently
   * replacing a verified row's data with an unrelated book's.
   *
   * This exists so an extraction-rule change — `stripMarcQualifier` being the
   * first — can be applied to every cached row for free, which is the split
   * `rederive.ts` was designed around.
   */
  rederive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return null;
    const { entities, subjects } = toPayload(raw as OpenLibraryDoc);
    return { entities, subjects };
  },
};
