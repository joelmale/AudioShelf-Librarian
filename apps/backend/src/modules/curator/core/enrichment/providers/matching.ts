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
/**
 * Shelf annotations that are not part of any published title.
 *
 * These come from filenames, not catalogues: a production house, a narrator
 * in parentheses, a shorthand volume code, a note about the contents. No
 * external provider indexes them, so a title carrying one matches nothing —
 * on a live run `Siren Song Full Cast (GraphicAudio)`, `Taran Wanderer
 * (Holmes)` and `Second Foundation [01] Foundation's Fear` all came back
 * not-found from every provider while the underlying books are perfectly well
 * catalogued.
 *
 * ── Why these are ADDED as candidates, never substituted ───────────────────
 * Stripping is a guess. `(Holmes)` is a narrator here but could be part of a
 * real title elsewhere, and a bracketed `[01]` could be a genuine bracketed
 * subtitle. Because `candidateTitles` is consumed by providers that verify
 * every hit with {@link matchesBook} before accepting it, an extra candidate
 * costs at most one wasted lookup and can never attach the wrong book — while
 * a substitution would silently destroy the one form that might have matched.
 * Order matters for the same reason: the parser's own best guesses stay
 * first, and these variants trail them, because `googleBooks.ts` caps how
 * many it will try.
 */
const TRAILING_ANNOTATION = /\s*[([][^)\]]*[)\]]\s*$/;
const BRACKETED_SEGMENT = /\s*\[[^\]]*\]\s*/g;
/** Production/format markers that trail a title rather than belonging to it. */
const PRODUCTION_MARKER = /\s*\b(?:full\s*cast|dramati[sz]ed|graphic\s*audio|audio\s*drama|radio\s*play)\s*$/i;

/** Variants of `title` with shelf annotations removed. Best-first, deduped. */
function withoutAnnotations(title: string): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    // A one-character remnant is not a title, it is what is left when the
    // strip ate the whole thing.
    if (trimmed.length > 1 && trimmed !== title && !out.includes(trimmed)) out.push(trimmed);
  };

  // `Siren Song Full Cast (GraphicAudio)` -> `Siren Song Full Cast` -> `Siren Song`
  const untrailed = title.replace(TRAILING_ANNOTATION, '');
  push(untrailed);
  push(untrailed.replace(PRODUCTION_MARKER, ''));
  push(title.replace(PRODUCTION_MARKER, ''));

  if (BRACKETED_SEGMENT.test(title)) {
    BRACKETED_SEGMENT.lastIndex = 0;
    // `Second Foundation [01] Foundation's Fear` -> `Second Foundation Foundation's Fear`
    push(title.replace(BRACKETED_SEGMENT, ' '));
    // ...and the far more likely reading: the bracket separates a series from
    // the actual title, so everything after the LAST bracket is the title.
    const tail = title.slice(title.lastIndexOf(']') + 1);
    push(tail);
  }
  return out;
}

export function candidateTitlesFor(book: Book): string[] {
  const parse = book.titleParse ?? parseTitle(book.title, book.author);
  const candidates = [...parse.candidateTitles];
  if (book.title && !candidates.includes(book.title)) candidates.push(book.title);

  const annotationFree: string[] = [];
  for (const candidate of candidates) {
    for (const variant of withoutAnnotations(candidate)) {
      if (!candidates.includes(variant) && !annotationFree.includes(variant)) annotationFree.push(variant);
    }
  }

  const withArticlesStripped: string[] = [];
  for (const candidate of [...candidates, ...annotationFree]) {
    const stripped = candidate.replace(/^\s*(?:a|an|the)\s+/i, '').trim();
    if (stripped && stripped !== candidate
      && !candidates.includes(stripped) && !annotationFree.includes(stripped)
      && !withArticlesStripped.includes(stripped)) {
      withArticlesStripped.push(stripped);
    }
  }
  return [...candidates, ...annotationFree, ...withArticlesStripped];
}

/**
 * Audiobook metadata routinely stores authors inverted — "Green, Simon R."
 * rather than "Simon R. Green" — because that is how library catalogues and
 * many taggers write them. Catalogue APIs index the natural order, so the
 * inverted form both queries badly and fails a naive comparison.
 *
 * Flips a SINGLE-comma name and leaves anything else alone: "Smith, John and
 * Jane Doe" or a list with two commas is not safely invertible, and a suffix
 * like "Green, Simon R., Jr." would be mangled. Returns the input unchanged
 * when there is nothing to flip.
 */
export function deinvertAuthor(author: string): string {
  const parts = author.split(',');
  if (parts.length !== 2) return author;
  const [last, first] = parts.map((p) => p.trim());
  if (!last || !first) return author;
  // A trailing generational/honorific suffix is not a given name.
  if (/^(jr|sr|i{1,3}|iv|v|phd|md)\.?$/i.test(first)) return author;
  return `${first} ${last}`;
}

/** Order-insensitive token set, used for author comparison. */
function tokens(value: string): Set<string> {
  return new Set(normalizeForMatching(value).split(' ').filter(Boolean));
}

/**
 * Authors match when one side's tokens are a subset of the other's.
 *
 * Deliberately NOT the substring test used for titles. Real pairs that must
 * match and do not survive a substring check:
 *   "Green, Simon R."  vs "Simon R. Green"   — order differs
 *   "Simon Green"      vs "Simon R. Green"   — middle initial only on one side
 * Subset-of-tokens handles both. It is looser than exact equality, but author
 * is the SECONDARY check here — the title has already had to match — so the
 * realistic failure it admits (two authors sharing a surname and a given name)
 * is much rarer than the false negatives it removes.
 */
function authorsMatch(wanted: string, found: string): boolean {
  const a = tokens(wanted);
  const b = tokens(found);
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (!large.has(t)) return false;
  return true;
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
  if (!normalizeForMatching(book.author)) return true;
  return (found.authors ?? []).some((name) => authorsMatch(book.author!, name));
}
