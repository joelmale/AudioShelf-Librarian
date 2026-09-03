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
 * `DescriptionSource` (`'audnexus' | 'wikidata' | 'googlebooks' |
 * 'openlibrary'`) is defined in `../types.ts` and imported here, NOT
 * redeclared — it is also the type of {@link Book.descriptionSource}, and a
 * second declaration would drift the moment a provider is added to one but
 * not the other. See that file's docblock for why it deliberately excludes
 * `'abs'`: this module's {@link resolveDescription} is where `'abs'`
 * legitimately appears, as the *effective* source when ABS's own description
 * wins — a different concept from provenance of a *harvested* value, which is
 * all `DescriptionSource` tracks.
 */
import type { Book } from '../types.js';
import { type DescriptionSource } from '../types.js';

/**
 * Fixed precedence for a harvested description when more than one provider's
 * cached row is eligible. NOT length-based — see
 * `MIN_HARVESTED_DESCRIPTION_CHARS`'s docblock and `resolveDescription`,
 * neither of which ever compares two candidates' lengths against each other
 * — and NOT a quality score of any kind: a fixed list is what keeps
 * `computeDescriptionWinner` a pure, deterministic function of a book's
 * cached rows, so `card_hash` churn stays predictable across runs as
 * cleaning rules evolve.
 *
 * Only membership participation is gated by
 * `EnrichmentProvider#extractDescription` (see that hook's docblock) — a
 * provider without the hook implemented is simply never consulted, no matter
 * where it sits here. The ordering below is argued on retrieval quality for
 * providers that DO implement it:
 *
 *  1. `'audnexus'` — permanently first, and neither `'wikidata'` nor
 *     `'openlibrary'` may demote it. It is the only source describing the
 *     EDITION actually on the shelf (ASIN-keyed to the specific audiobook —
 *     abridgement, full-cast, dramatization), where every other source
 *     describes the work in the abstract or a print edition. R2 ratified
 *     this ordering; it is not re-opened here.
 *  2. `'wikidata'` — second, above `'googlebooks'`. This member is the
 *     Wikipedia intro of a Wikidata-verified page (see `providers/
 *     wikidata.ts`'s `extractDescription`; there is deliberately no separate
 *     `'wikipedia'` provider — the enwiki title only exists as a verified
 *     fact inside wikidata.ts's own lookup, after `verifyEntity` passes, and
 *     splitting it out would mean either a second rate limiter against a
 *     host Wikimedia has already throttled, or a provider reading another
 *     provider's cached row mid-lookup). It outranks `'googlebooks'` on
 *     proper-noun density: an encyclopedia intro typically names protagonist,
 *     antagonist, setting and often secondary cast, which is precisely the
 *     input to `entityNotability.ts`'s `DESCRIPTION_MATCH_SCORE` and to
 *     `tagging/ground.ts#groundCharacter`'s fallback substring gate, where
 *     marketing copy usually names one or two. It is also third-party
 *     editorial rather than seller copy — no "Now a major motion picture",
 *     no "From the #1 bestselling author of…" — noise `cleanHarvestedDescription`
 *     cannot remove because it is prose, not markup, and which burns budget
 *     inside `bookCard.ts`'s truncation. The honest counterweight: encyclopedic
 *     register carries fewer vibe adjectives than marketing copy, which is
 *     what a mood/pacing query embeds against. Accepted, because mood signal
 *     has other suppliers (provider subjects routed into the vocab pipeline,
 *     `book_tags` on the card independently) where the entity allowlist has
 *     no substitute. This only bites books with no ABS description — see
 *     `resolveDescription` below — the indie/mid-list majority where
 *     `'wikidata'` rarely resolves at all, so the stakes of this position are
 *     genuinely small.
 *  3. `'googlebooks'` — third. Publisher marketing copy for the PRINT
 *     edition: right register for embedding vibe, wrong edition, seller
 *     framing, and the source already known to carry marketing HTML (see
 *     `cleanHarvestedDescription`'s docblock).
 *  4. `'openlibrary'` — last, as a floor. A WORK-level description spans
 *     every edition, translation and abridgement at once (no edition concept
 *     at all), and OL work records are sparse and frequently a copy of a
 *     publisher blurb or a Wikipedia paragraph. Last position is what makes
 *     it a floor that only fires where the other three are silent, not a
 *     source competing with them on quality.
 *
 * Reordering this list is a retrieval-quality decision that RE-ATTRIBUTES
 * already-backfilled books the next time `backfillDescriptions` runs —
 * `computeDescriptionWinner` recomputes a book's winner from scratch, from
 * whatever is currently cached, on every run; it does not remember a prior
 * winner. A member gains any live effect only once its owning provider
 * implements `extractDescription`, so adding a member here ahead of that
 * (as this list does for `'wikidata'`/`'openlibrary'` at the point they were
 * added) changes no winner and triggers no re-embed — see
 * `descriptionBackfill.test.ts`'s "contract commit is inert" coverage.
 */
export const DESCRIPTION_SOURCE_PRECEDENCE: readonly DescriptionSource[] = [
  'audnexus',
  'wikidata',
  'googlebooks',
  'openlibrary',
];

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

/** HTML comments, whole, including their content — removed before anything
 *  else runs. A comment is boilerplate ("hidden marketing", editorial notes)
 *  that was never meant to be read as prose, so unlike a stripped tag it is
 *  dropped together with its text, not just unwrapped. */
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** `<script>`/`<style>` elements, tag AND inner content, removed before
 *  anything else runs. Unlike an inline tag such as `<em>`, stripping just
 *  the tags here would leave the element's payload (CSS rules, JS source)
 *  behind as if it were prose. Non-greedy + explicit matching close tag so
 *  one script block never swallows past its own `</script>`. */
const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

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

/** Highest valid Unicode scalar value `String.fromCodePoint` accepts. A
 *  numeric entity outside this range (or, as `Number.parseInt` never
 *  produces, non-integral) is malformed input, not a code path this module
 *  is willing to throw over — see `codePointToString`. */
const MAX_CODE_POINT = 0x10ffff;

/** `String.fromCodePoint`, but total: an out-of-range value (a malformed
 *  numeric entity like `&#99999999999;`, which real harvested descriptions
 *  have contained) returns `null` instead of throwing a `RangeError`. A
 *  throw here would escape `computeDescriptionWinner`'s precedence loop in
 *  `./descriptionBackfill.ts` and cost a book its next-best-precedence
 *  candidate over one bad character in the losing one — see this module's
 *  test for the reproduction. */
function codePointToString(value: number): string | null {
  if (!Number.isInteger(value) || value < 0 || value > MAX_CODE_POINT) return null;
  return String.fromCodePoint(value);
}

function decodeEntity(_match: string, decimal: string | undefined, hex: string | undefined, named: string | undefined): string {
  if (decimal !== undefined) return codePointToString(Number.parseInt(decimal, 10)) ?? _match;
  if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16)) ?? _match;
  if (named !== undefined && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, named)) {
    return NAMED_ENTITIES[named];
  }
  // Unknown named entity (e.g. `&trade;`) or an out-of-range numeric one:
  // left exactly as written, the same "don't guess" rule as an unknown name.
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
 *   1. HTML entities decoded in one pass against a closed table, plus numeric
 *      decimal/hex forms; an unrecognised named entity is left verbatim.
 *      Decoding runs FIRST, before any tag stripping: some cached provider
 *      payloads (publisher/ONIX-derived Google Books text, observed in the
 *      wild) carry their markup entity-escaped — `&lt;i&gt;...&lt;/i&gt;` —
 *      rather than literal. Stripping tags before decoding would leave that
 *      markup encoded, decode it back to live `<i>...</i>` on the very next
 *      read, and land it on the card, in the embedding text, and in the
 *      tagging prompt. Decoding first turns it into ordinary literal tags,
 *      which step 3 below then strips like any other markup. This is still
 *      exactly one pass (`String#replace` never rescans its own output), so
 *      the no-double-decode property in step 1's own implementation
 *      (`&amp;lt;` → the literal text `&lt;`, never `<`) is unaffected —
 *      that text contains no actual `<` character, so it is never mistaken
 *      for a tag by steps 2/3.
 *   2. HTML comments, and `<script>`/`<style>` elements together with their
 *      inner content, removed outright — never surfaced as prose.
 *   3. Block-level tags/close-tags → single space (sentence boundaries
 *      survive), then any remaining tag removed outright (no replacement).
 *   4. Whitespace collapsed and trimmed.
 *
 * The raw HTML itself is never touched — it stays verbatim in
 * `external_metadata.payload.raw` — so this rule is free to improve and
 * re-run without losing anything.
 */
export function cleanHarvestedDescription(raw: string): string {
  const decoded = raw.replace(ENTITY_RE, decodeEntity);
  const withoutComments = decoded.replace(COMMENT_RE, ' ');
  const withoutScriptStyle = withoutComments.replace(SCRIPT_STYLE_RE, ' ');
  const spaced = withoutScriptStyle.replace(BLOCK_BOUNDARY_RE, ' ');
  const untagged = spaced.replace(REMAINING_TAG_RE, '');
  return collapseWhitespace(untagged);
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
