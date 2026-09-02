/**
 * Effective-description resolution and HTML cleaning for the description
 * backfill (librarian engine plan, `docs/enrichment-sources-review.md` R2).
 *
 * Pure, no DB import, no I/O — the same `entityNotability.ts` (pure) /
 * `rebuild.ts` (DB-facing) split this module family already uses. The
 * DB-facing half (reading cached payloads, writing
 * `description_enriched`/`description_source`) lives in
 * `./descriptionBackfill.ts`.
 *
 * `DescriptionSource` (`'audnexus' | 'googlebooks'`) is defined in
 * `../types.ts` and imported here, NOT redeclared — it is also the type of
 * {@link Book.descriptionSource}, and a second declaration would drift the
 * moment a provider is added to one but not the other. See that file's
 * docblock for why it deliberately excludes `'abs'`: this module's
 * {@link resolveDescription} is where `'abs'` legitimately appears, as the
 * *effective* source when ABS's own description wins — a different concept
 * from provenance of a *harvested* value, which is all `DescriptionSource`
 * tracks.
 */
import type { Book } from '../types.js';
import { type DescriptionSource } from '../types.js';

/**
 * Fixed precedence for a harvested description when more than one provider's
 * cached row is eligible. Audnexus first: it is audiobook-native and usually
 * ASIN-keyed, i.e. resolves to the exact edition the user owns, where Google
 * Books resolves the print edition and is the source known to carry
 * publisher marketing HTML. This is NOT length-based — see
 * `MIN_HARVESTED_DESCRIPTION_CHARS`'s docblock and `resolveDescription`,
 * neither of which ever compares two candidates' lengths against each other.
 */
export const DESCRIPTION_SOURCE_PRECEDENCE: readonly DescriptionSource[] = ['audnexus', 'googlebooks'];

/**
 * A cleaned candidate shorter than this is discarded, never stored. A
 * sub-sentence stub carries neither a situation nor a character name — the
 * two things R2 exists to supply — so storing it would cost a card line and
 * a `DESCRIPTION_MATCH_SCORE` opportunity for nothing.
 */
export const MIN_HARVESTED_DESCRIPTION_CHARS = 80;

/**
 * A cleaned candidate longer than this is REJECTED, not truncated. A ~10k
 * "description" is a front-matter or table-of-contents dump — a shape
 * problem, not a length problem — and storing half of a wrong thing is worse
 * than storing nothing. Truncation for presentation (card, prompt,
 * recommendations) happens per-consumer at read time and must never be
 * baked into storage.
 */
export const MAX_HARVESTED_DESCRIPTION_CHARS = 10_000;

/** Block-level tags/entities replaced with a single space, case-insensitive,
 *  BEFORE remaining tags are stripped — otherwise `end.<p>Next` would become
 *  `end.Next` with the sentence boundary erased. */
const BLOCK_BOUNDARY_RE = /<br\s*\/?>|<\/(?:p|div|li)>/gi;

/** Any remaining tag. Anchored on a letter after the optional `/` so a
 *  literal `5 < 6` in prose (not followed by a tag name) survives. */
const REMAINING_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

/** Closed table of named HTML entities this module decodes. Anything outside
 *  it (`&trade;`, say) is left verbatim rather than guessed at or dropped —
 *  see the module docblock's "no boilerplate stripping" stance: decoding is
 *  mechanical, never a heuristic about what the text means. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/** Every HTML entity form this module recognises, decoded in ONE pass over
 *  the original string (via `String#replace`, which never rescans its own
 *  output) — the property that makes `&amp;lt;` decode to the literal text
 *  `&lt;` rather than double-decoding into `<`. */
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g;

function decodeEntity(_match: string, decimal: string | undefined, hex: string | undefined, named: string | undefined): string {
  if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
  if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
  if (named !== undefined && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, named)) {
    return NAMED_ENTITIES[named];
  }
  // Unknown named entity (e.g. `&trade;`): left exactly as written.
  return _match;
}

/** Collapse all whitespace runs (including newlines, and `&nbsp;`'s decoded
 *  U+00A0, which `\s` matches) to single spaces and trim — the same rule
 *  `bookCard.ts#collapseWhitespace` uses. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Clean a raw provider description into plain text, deterministically and
 * idempotently on already-plain text. Runs unconditionally on every source —
 * no per-provider branching — in exactly this order:
 *
 *   1. Block-level tags/close-tags → single space (sentence boundaries survive).
 *   2. Remaining tags removed outright (no replacement).
 *   3. HTML entities decoded in one pass against a closed table, plus numeric
 *      decimal/hex forms; an unrecognised named entity is left verbatim.
 *   4. Whitespace collapsed and trimmed.
 *
 * The raw HTML itself is never touched — it stays verbatim in
 * `external_metadata.payload.raw` — so this rule is free to improve and
 * re-run without losing anything.
 */
export function cleanHarvestedDescription(raw: string): string {
  const spaced = raw.replace(BLOCK_BOUNDARY_RE, ' ');
  const untagged = spaced.replace(REMAINING_TAG_RE, '');
  const decoded = untagged.replace(ENTITY_RE, decodeEntity);
  return collapseWhitespace(decoded);
}

/** Effective source of a resolved description: a {@link DescriptionSource}
 *  when a harvested value won, or `'abs'` when ABS's own text won. Distinct
 *  from {@link DescriptionSource} itself — see the module docblock. */
export type EffectiveDescriptionSource = DescriptionSource | 'abs';

export interface ResolvedDescription {
  text: string | null;
  source: EffectiveDescriptionSource | null;
}

/**
 * THE single effective-description rule. Every consumer (the embedding
 * card, entity notability, tag grounding, the tagging prompt,
 * recommendations) calls this instead of reading `book.description` or
 * `book.descriptionEnriched` directly.
 *
 * ABS wins whenever it has a non-blank description, full stop — there is no
 * length comparison here, in either direction: a 40-character ABS blurb
 * beats a 4000-character harvested one, because `books.description` is the
 * user's own library metadata and demoting it on an unmeasured "shorter is
 * worse" hypothesis is exactly what this function exists not to do (see
 * `docs/enrichment-sources-review.md`'s R2 errata). Presence is
 * `trim() !== ''`, not merely `!== null` — a whitespace-only ABS value is
 * treated as absent, the same convention `tagging/compose.ts#hasDescription`
 * uses.
 *
 * When ABS is absent, the harvested pair wins if present. Otherwise there is
 * no description at all.
 *
 * Deliberate consequence, recorded here rather than hidden: this widens
 * `tagging/ground.ts#groundCharacter`'s fallback substring gate for books
 * with no person allowlist, since that gate reads whatever effective
 * description this function returns. Accepted, not compensated for with a
 * heuristic, because (a) those books are exactly R2's intended
 * beneficiaries — a real protagonist named in the blurb should now ground —
 * (b) the admitted tag lands as `source: 'llm-open'` and is excluded from
 * hard filters, and (c) the name must still appear literally in the text.
 * `DescriptionBackfillResult.groundingGateWidened` measures the population
 * this affects instead of guessing at it.
 */
export function resolveDescription(book: Book): ResolvedDescription {
  // `typeof ... === 'string'` rather than `!== null`: `Book.description` is
  // typed as required, but a handful of call sites in this codebase
  // construct partial/stubbed `Book`-shaped objects (test doubles cast
  // through `as never`, mostly) where the field is simply absent rather than
  // explicitly `null`. Guarding on the type, not just the null-check, is
  // what keeps this a safe drop-in for `book.description ? ... : ''`
  // everywhere it replaces that pattern.
  if (typeof book.description === 'string' && book.description.trim() !== '') {
    return { text: book.description, source: 'abs' };
  }
  if (typeof book.descriptionEnriched === 'string' && book.descriptionEnriched.length > 0) {
    return { text: book.descriptionEnriched, source: book.descriptionSource ?? null };
  }
  return { text: null, source: null };
}
