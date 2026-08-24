/**
 * External key convention for `book_edges.to_book` (librarian engine plan
 * §1.5, §10.H).
 *
 * `book_edges.to_book` may reference a work the user does not own — the
 * 'comparable' relation (readalike) points at external anchors that have no
 * `books.id`. Without a defined key format those edges are unjoinable and
 * collide across differently-spelled titles ("Les Misérables" vs "Les
 * Miserables", or "Leviathan Wakes (Unabridged)" vs "Leviathan Wakes,
 * Unabridged", would otherwise be two rows instead of one). This module is
 * the ONLY place an external key may be minted — every writer of a
 * 'comparable' edge (and any future reader that needs to compare external
 * anchors) must go through `externalBookKey`.
 *
 * What it does NOT unify — do not assume otherwise, because the PK is
 * `(from_book, to_book, relation)` and a wrong assumption mints a duplicate
 * row that nothing will ever clean up:
 * - **Series prefixes and subtitles.** "The Expanse: Leviathan Wakes" and
 *   "Leviathan Wakes" are different keys. Strip the prefix before minting if
 *   the caller knows one is present.
 * - **Non-Latin scripts.** See the throw note below.
 *
 * Convention: `ext:<normalized-title>|<normalized-author>`, where
 * `normalizeForMatching` lowercases, strips a trailing "(Unabridged)" /
 * "(Abridged)" marker, collapses punctuation/whitespace to single spaces,
 * and trims. The `ext:` prefix keeps the key visibly distinct from a real
 * `books.id` at a glance (and out of the same namespace, so a future
 * `to_book` value can never be mistaken for one or the other).
 *
 * Edge cases (deliberate):
 * - Missing/empty author normalizes to `''`, producing `ext:<title>|`. This
 *   is allowed and stable — plenty of readalike anchors surface without a
 *   confident author — but it means two same-titled works by different
 *   unknown authors collide. That is accepted as a known limitation rather
 *   than solved here.
 * - A title that normalizes to `''` cannot identify a work at all, so
 *   `externalBookKey` throws rather than minting a degenerate `ext:|...` key
 *   that would silently collide with every other titleless anchor.
 *
 *   **This fires for far more than empty input.** The strip keeps only
 *   `[a-z0-9]`, so ANY title with no ASCII alphanumerics normalizes to empty
 *   and throws — every non-Latin-script title included: `三体`,
 *   `Война и мир`, `こころ`. Accent folding does not help; CJK and Cyrillic
 *   have nothing to fold to. The librarian returning a Japanese or Russian
 *   readalike anchor is entirely plausible.
 *
 *   The throw is deliberate — silently returning `null` would drop such an
 *   anchor with no signal — so **callers must guard per-anchor** and skip the
 *   ones that throw, using the record-and-continue idiom at
 *   `api/routes/titleParse.ts` (A4). One bad anchor must never abort a batch.
 * - Key order is fixed (title before author) and is not itself meaningful
 *   beyond being stable — callers must not rely on parsing order for
 *   anything other than recovering the two fields via `parseExternalBookKey`.
 */

/**
 * Normalize a title or author string for case/formatting-insensitive
 * matching: lowercase, strip an "(Unabridged)"/"(Abridged)" edition marker,
 * collapse any run of non-alphanumeric characters to a single space, and
 * trim. Shared by external-key minting and iTunes candidate matching —
 * behaviour here is load-bearing for both, so changes must stay
 * byte-identical across all call sites.
 */
/** Latin-script letters with no NFKD decomposition — see `normalizeForMatching`. */
const LATIN_FOLD: Record<string, string> = {
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ħ: 'h',
  ŧ: 't',
  ı: 'i',
};

export function normalizeForMatching(value: string): string {
  return (
    value
      .toLowerCase()
      // Edition markers, in the two shapes that are safe to strip. Bracketed
      // anywhere, or trailing after a separator — never a bare `\bunabridged\b`,
      // which would gut "The Unabridged Journals of Sylvia Plath" (tested).
      .replace(/[([](?:un)?abridged(?:\s+edition)?[)\]]/g, '')
      .replace(/[\s,:;–—-]+(?:un)?abridged(?:\s+edition)?\s*$/, '')
      // Fold accents to their base letters BEFORE the strip below, which would
      // otherwise delete the accented character outright and turn "Misérables"
      // into "mis rables" — a different key from "Miserables".
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      // NFKD only decomposes combining accents. Stroked/barred letters and
      // ligatures have no decomposition, so "Stanisław" would still strip to
      // "stanis aw". These are the Latin-script letters that actually turn up
      // in author names; anything outside the map falls through to the strip.
      .replace(/[łøđðþæœßħŧı]/g, (c) => LATIN_FOLD[c] ?? c)
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

const EXTERNAL_KEY_PREFIX = 'ext:';

/**
 * Mint the external key for a non-owned work referenced by `book_edges.to_book`.
 * Two differently-spelled references to the same work (case, edition suffix,
 * punctuation, extra whitespace) produce the same key. Author may be empty
 * (see module docblock), but a title that normalizes to the empty string is
 * rejected — it cannot identify a work.
 */
export function externalBookKey(title: string, author: string): string {
  const normalizedTitle = normalizeForMatching(title);
  if (!normalizedTitle) {
    throw new Error(`externalBookKey: title "${title}" normalizes to empty; cannot mint a key`);
  }
  const normalizedAuthor = normalizeForMatching(author);
  return `${EXTERNAL_KEY_PREFIX}${normalizedTitle}|${normalizedAuthor}`;
}

/** True if `key` was minted by `externalBookKey` (i.e. `to_book` refers to a non-owned work). */
export function isExternalBookKey(key: string): boolean {
  return key.startsWith(EXTERNAL_KEY_PREFIX);
}

/**
 * Recover the normalized title/author from an external key. Returns `null`
 * for a non-external key (no `ext:` prefix) or a malformed one (missing the
 * `|` separator). The returned strings are already normalized — they are
 * not the original title/author casing, which the key does not preserve.
 */
export function parseExternalBookKey(key: string): { title: string; author: string } | null {
  if (!isExternalBookKey(key)) return null;
  const body = key.slice(EXTERNAL_KEY_PREFIX.length);
  const separatorIndex = body.indexOf('|');
  if (separatorIndex === -1) return null;
  return {
    title: body.slice(0, separatorIndex),
    author: body.slice(separatorIndex + 1),
  };
}
