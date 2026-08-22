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
 *   2. Title/author search, used when there is no ISBN or the ISBN search
 *      returned no docs — candidates are verified against the book's
 *      normalized title (and author, when known) before being accepted.
 */
import { AppError } from '../../errors.js';
import type { Book } from '../../types.js';
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

/** Same normalization idiom as recommendations.ts#normalized — copied, not imported. */
function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/\((?:unabridged|abridged)\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

function titleAuthorSearchUrl(book: Book): string {
  const parts = [`title:"${book.title}"`];
  if (book.author) parts.push(`author:"${book.author}"`);
  return `${SEARCH_URL}?q=${encodeURIComponent(parts.join(' '))}&fields=${FIELDS}&limit=3`;
}

/** Match verification for the title/author path only — ISBN hits are trusted. */
function matchesBook(doc: OpenLibraryDoc, book: Book): boolean {
  const wantedTitle = normalized(book.title);
  const foundTitle = normalized(doc.title ?? '');
  if (!fuzzyEquals(wantedTitle, foundTitle)) return false;
  if (!book.author) return true;
  const wantedAuthor = normalized(book.author);
  if (!wantedAuthor) return true;
  return (doc.author_name ?? []).some((name) => fuzzyEquals(wantedAuthor, normalized(name)));
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

    const titleResult = await runSearch(fetchImpl, titleAuthorSearchUrl(book));
    const match = titleResult.docs.find((doc) => matchesBook(doc, book));
    return match ? toPayload(match) : null;
  },
};
