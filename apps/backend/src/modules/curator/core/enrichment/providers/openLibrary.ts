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
import { normalizeForMatching } from '../../externalKey.js';
import type { Book } from '../../types.js';
import { parseTitle } from '../titleParse.js';
import type { EnrichedEntity, EnrichmentPayload, EnrichmentProvider, EntityKind } from '../types.js';

const SEARCH_URL = 'https://openlibrary.org/search.json';
const FIELDS = 'key,title,author_name,person,place,time,subject';
const TIMEOUT_MS = 15_000;

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

/**
 * Shared with external-key minting and iTunes matching — see
 * `externalKey.ts#normalizeForMatching`. Imported, never copied: three
 * byte-identical copies of this used to exist, and a fix to one silently left
 * the others behind.
 */
const normalized = normalizeForMatching;

function fuzzyEquals(wanted: string, found: string): boolean {
  return Boolean(wanted && found) && (wanted === found || wanted.includes(found) || found.includes(wanted));
}

async function runSearch(fetchImpl: typeof fetch, url: string): Promise<OpenLibrarySearchResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const message = isTimeout
      ? `Open Library request timed out after ${TIMEOUT_MS}ms: ${url}`
      : `Could not reach Open Library: ${url}`;
    throw new AppError('INTERNAL', message, { cause: err });
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
  if (author) parts.push(`author:"${author}"`);
  return `${SEARCH_URL}?q=${encodeURIComponent(parts.join(' '))}&fields=${FIELDS}&limit=3`;
}

/**
 * Match verification for the title/author path only — ISBN hits are
 * trusted. Verifies against `wantedTitle` (the specific candidate title this
 * search was run for), not the book's raw, possibly filename-mangled title.
 */
function matchesBook(doc: OpenLibraryDoc, wantedTitle: string, book: Book): boolean {
  const wanted = normalized(wantedTitle);
  const foundTitle = normalized(doc.title ?? '');
  if (!fuzzyEquals(wanted, foundTitle)) return false;
  if (!book.author) return true;
  const wantedAuthor = normalized(book.author);
  if (!wantedAuthor) return true;
  return (doc.author_name ?? []).some((name) => fuzzyEquals(wantedAuthor, normalized(name)));
}

/**
 * Titles to try, best-first: the book's `title_parse` (read when present,
 * else computed inline via `parseTitle`) `candidateTitles`, then the raw
 * `book.title` as a final fallback when it isn't already among them.
 */
function candidateTitlesFor(book: Book): string[] {
  const parse = book.titleParse ?? parseTitle(book.title, book.author);
  const candidates = [...parse.candidateTitles];
  if (!candidates.includes(book.title)) candidates.push(book.title);
  return candidates;
}

function pushEntities(entities: EnrichedEntity[], seen: Set<string>, values: string[] | undefined, kind: EntityKind): void {
  for (const value of values ?? []) {
    const trimmed = value.trim();
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
    const isbn = book.isbn ? book.isbn.replace(/[^a-zA-Z0-9]/g, '') : '';
    if (isbn) {
      const isbnResult = await runSearch(fetchImpl, isbnSearchUrl(isbn));
      const [doc] = isbnResult.docs;
      if (doc) return toPayload(doc);
    }

    if (!book.title) return null;

    let lastError: unknown = null;
    let anySucceeded = false;
    for (const title of candidateTitlesFor(book)) {
      let titleResult: OpenLibrarySearchResponse;
      try {
        titleResult = await runSearch(fetchImpl, titleAuthorSearchUrl(title, book.author));
      } catch (err) {
        // This candidate's search failed outright (e.g. a transient 404/500)
        // — try the next candidate rather than aborting the whole lookup.
        lastError = err;
        continue;
      }
      anySucceeded = true;
      const match = titleResult.docs.find((doc) => matchesBook(doc, title, book));
      if (match) return toPayload(match);
    }

    // Every candidate's search failed at the transport/parse level (none
    // merely mismatched) — surface the failure rather than silently caching
    // 'not-found' for what was actually an outage.
    if (!anySucceeded && lastError) throw lastError;
    return null;
  },
};
