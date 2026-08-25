/**
 * Match verification shared by the title/author search providers
 * (`openLibrary.ts`, `googleBooks.ts`).
 *
 * Extracted rather than copied for the reason `openLibrary.ts` already
 * records about `normalizeForMatching`: byte-identical copies of matching
 * logic have drifted in this codebase before, and a fix to one silently left
 * the others behind. A provider that searches by title/author needs exactly
 * these three pieces, so they live in one place.
 *
 * ISBN lookups deliberately do NOT go through here — an ISBN hit is
 * definitionally the right edition and is trusted verbatim by both providers.
 */
import { normalizeForMatching } from '../../externalKey.js';
import type { Book } from '../../types.js';
import { parseTitle } from '../titleParse.js';

/**
 * Substring-tolerant equality on already-normalized strings. Deliberately
 * loose in both directions: catalogue titles routinely carry a subtitle the
 * library's filename lacks ("A Curiously Convenient Demise: A laugh-out-loud
 * cosy crime novel"), and the reverse happens too.
 */
export function fuzzyEquals(wanted: string, found: string): boolean {
  return Boolean(wanted && found) && (wanted === found || wanted.includes(found) || found.includes(wanted));
}

/**
 * Titles to try, best-first: the book's `title_parse` (read when present,
 * else computed inline via `parseTitle`) `candidateTitles`, then the raw
 * `book.title` as a final fallback when it isn't already among them.
 *
 * A leading article is stripped into an ADDITIONAL candidate (never a
 * replacement) because catalogue title indexes disagree about whether to keep
 * it. Open Library's exact-phrase title search returns zero results for
 * `title:"A Curiously Convenient Demise"` and one correct result for
 * `title:"Curiously Convenient Demise"` — the book was catalogued without the
 * article. Verification still guards every candidate, so an extra one costs
 * at most one request and cannot produce a false positive.
 */
export function candidateTitlesFor(book: Book): string[] {
  const parse = book.titleParse ?? parseTitle(book.title, book.author);
  const candidates = [...parse.candidateTitles];
  if (book.title && !candidates.includes(book.title)) candidates.push(book.title);

  const withoutArticles: string[] = [];
  for (const candidate of candidates) {
    const stripped = candidate.replace(/^\s*(?:a|an|the)\s+/i, '').trim();
    if (stripped && stripped !== candidate && !candidates.includes(stripped)) withoutArticles.push(stripped);
  }
  return [...candidates, ...withoutArticles];
}

/**
 * Verify a candidate result against the book. Checks the SPECIFIC candidate
 * title this search was run for — not the book's raw, possibly
 * filename-mangled title — plus the author when the book has one.
 *
 * A book with no author (or one that normalizes to empty) passes on title
 * alone: that is weaker, but the alternative is never enriching those books.
 */
export function matchesBook(
  found: { title?: string | undefined; authors?: readonly string[] | undefined },
  wantedTitle: string,
  book: Book
): boolean {
  const wanted = normalizeForMatching(wantedTitle);
  if (!fuzzyEquals(wanted, normalizeForMatching(found.title ?? ''))) return false;
  if (!book.author) return true;
  const wantedAuthor = normalizeForMatching(book.author);
  if (!wantedAuthor) return true;
  return (found.authors ?? []).some((name) => fuzzyEquals(wantedAuthor, normalizeForMatching(name)));
}
