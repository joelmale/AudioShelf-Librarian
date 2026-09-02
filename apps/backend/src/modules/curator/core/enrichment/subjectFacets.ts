/**
 * Provider-facet routing table for R1 (docs/enrichment-sources-review.md §3,
 * "Wire `subjects` into the canonicalizer") — the ONLY thing consulted to
 * decide which {@link TagCategory} a provider's harvested subject strings
 * become candidates for.
 *
 * Category is a property of the PROVIDER FIELD, decided by what the provider
 * itself calls that field — NEVER by inspecting the term. `horror` is a genre
 * and `friendship` is a theme, but Open Library's `subject[]` carries both in
 * one array; the only rule that survives contact with a real subject list is
 * "what did the provider call this field": Google Books `categories` (BISAC),
 * Audnexus `genres` (both `type:'genre'` and `type:'tag'` land in that one
 * field), Wikidata P136 (literally named `genre`), and Hardcover `genres` are
 * all self-declared genre taxonomies; Hardcover `moods` is a self-declared
 * mood taxonomy; Open Library `subject` is a MARC topical field — "what the
 * book is about" — which is `theme`. Hardcover `tags` declares nothing (its
 * own module docblock flags the whole GraphQL document as unverified against
 * the live API) and is deliberately absent from this table: it contributes to
 * no facet and is silently dropped. Extending or correcting a routing
 * decision is a one-line edit here; because R1 (`promoteSubjects.ts`) is
 * cache-only and idempotent, a re-run after such an edit is free.
 *
 * `splitHeading`/`isMachineTag` moved here VERBATIM from
 * `providers/googleBooks.ts` (a pure refactor — `googleBooks.test.ts` passes
 * unchanged) so every provider's stored strings get the same hierarchical
 * splitting Google Books already had, not just Google Books' own. Both are
 * idempotent on their own output, which is what makes re-splitting an
 * already-split Google Books row a no-op.
 */
import { normalizeTagForm } from '../tagging/canonicalize.js';
import type { TagCategory } from '../types.js';
import { hardcoverFacets } from './providers/hardcover.js';

/**
 * A machine tag rather than a subject — `nyt:trade_fiction_paperback=2011-12-31`
 * is an indexing artifact that appeared verbatim in a real run's report.
 * Keyed on carrying BOTH a `:` and a `=`, which no natural heading does.
 *
 * Moved verbatim from `googleBooks.ts`.
 */
export function isMachineTag(term: string): boolean {
  return term.includes(':') && term.includes('=');
}

/**
 * Split one heading-shaped subject string into candidate facet terms.
 *
 * BISAC paths are slash-delimited ("Fiction / Mystery & Detective / Cozy").
 * Some records also carry comma-delimited headings ("Fiction, science
 * fiction, general"). Commas are split **only when the segment contains no
 * `&`**, because a compound leaf legitimately contains one: "Boats, Ships &
 * Underwater Craft" and "occult & supernatural fiction" must survive intact.
 * That single guard is what makes comma splitting safe rather than shredding.
 *
 * Moved verbatim from `googleBooks.ts`.
 */
export function splitHeading(category: string): string[] {
  const out: string[] = [];
  for (const bySlash of category.split('/')) {
    if (bySlash.includes('&')) out.push(bySlash);
    else out.push(...bySlash.split(','));
  }
  return out;
}

/** Ceiling on surviving terms per (book, provider, facet), after splitting and
 *  trimming and before canonicalization — the same ceiling and the same
 *  post-split placement as `googleBooks.ts#extractSubjects`'s `slice(0, 12)`,
 *  for the same reason: one over-categorized row must not crowd out the other
 *  providers. Open Library is the row that actually needs it — `doc.subject`
 *  carries no cap of its own and a real record can list hundreds. */
export const MAX_TERMS_PER_FACET_ROW = 12;

/**
 * Split, trim, and drop machine tags and case-insensitive "general" segments
 * from a provider's raw stored subject strings, then dedupe case-insensitively
 * and cap at {@link MAX_TERMS_PER_FACET_ROW}, in stored order.
 *
 * "General" is dropped here (not only via the stoplist below) because it is
 * BISAC's explicit "the publisher declined to subcategorize" leaf and never a
 * legitimate facet term at any frequency — the same reasoning
 * `googleBooks.ts#extractSubjects` already applies to its own output.
 */
export function surfaceFacetTerms(rawTerms: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawTerm of rawTerms) {
    if (typeof rawTerm !== 'string') continue;
    for (const segment of splitHeading(rawTerm)) {
      const trimmed = segment.trim();
      if (!trimmed || isMachineTag(trimmed)) continue;
      if (trimmed.toLowerCase() === 'general') continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.slice(0, MAX_TERMS_PER_FACET_ROW);
}

/**
 * Exact normalized forms dropped at any frequency, on every provider — what
 * kills the top-level `FICTION` BISAC facet and the "general" leaf by name
 * rather than by the library-share ceiling below (`fiction`/`general` are
 * contentless on a fiction-only library regardless of how rare or common they
 * turn out to be).
 */
export const SUBJECT_STOP_TERMS: ReadonlySet<string> = new Set([
  'fiction',
  'general',
  'fiction-general',
  'nonfiction',
  'non-fiction',
  'literature',
  'literary',
  'books',
  'book',
  'audiobook',
  'audiobooks',
  'ebook',
]);

/**
 * Hyphen-separated tokens that disqualify a normalized term when ANY token
 * matches — what kills a comma-blob heading the `&`-guard in
 * {@link splitHeading} deliberately leaves whole, e.g. "Fiction, mystery &
 * detective, general" normalizes to `fiction-mystery-detective-general`, and
 * the `general` token catches it even though the exact form is not in
 * {@link SUBJECT_STOP_TERMS}.
 */
export const SUBJECT_STOP_TOKENS: ReadonlySet<string> = new Set(['general']);

/**
 * Normalize one surviving segment (from {@link surfaceFacetTerms}) and apply
 * the stoplist. Returns `null` when the segment should be dropped entirely —
 * never guessed at, never partially kept.
 */
export function normalizeSubjectCandidate(segment: string): string | null {
  const norm = normalizeTagForm(segment);
  if (norm === '') return null;
  if (SUBJECT_STOP_TERMS.has(norm)) return null;
  if (norm.split('-').some((token) => SUBJECT_STOP_TOKENS.has(token))) return null;
  return norm;
}

/**
 * Full per-(book, provider, facet) pipeline: {@link surfaceFacetTerms} then
 * {@link normalizeSubjectCandidate}, deduped on the normalized form. Exists as
 * one call so `promoteSubjects.ts` and tests exercise the exact same pipeline
 * rather than two hand-assembled halves that could silently diverge.
 */
export function deriveSubjectCandidates(rawTerms: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of surfaceFacetTerms(rawTerms)) {
    const norm = normalizeSubjectCandidate(segment);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Library-share ceiling: a term evidenced on more than this fraction of
 * active books is dropped as boilerplate (Open Library's mention-index
 * artifacts — `accessible-book`, `in-library`, `protected-daisy` and
 * whatever else a real corpus turns out to hold — chief among them) rather
 * than a genuine facet term. Self-tuning by design: it catches boilerplate
 * without enumerating a guessed vocabulary for a source with no published
 * one, and 0.4 is comfortably above the real long tail (§10.M's 65 `mystery`
 * books are 6.7% of a ~965-book library).
 */
export const MAX_LIBRARY_SHARE = 0.4;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** One (provider, facet) routing entry: which stored field to read, and which
 *  {@link TagCategory} it feeds. `extract` receives the row's decoded
 *  `EnrichmentPayload`-shaped object (`{ subjects?, raw?, ... }`) and returns
 *  RAW, unsplit, unfiltered candidate strings — {@link surfaceFacetTerms} and
 *  {@link normalizeSubjectCandidate} do the rest, uniformly, for every
 *  provider. */
export interface SubjectFacetEntry {
  readonly provider: string;
  readonly category: TagCategory;
  readonly extract: (payload: Record<string, unknown>) => string[];
}

/**
 * The whole routing table. See the module docblock for the single rule that
 * generates it. Hardcover `tags` is deliberately absent — it contributes to
 * no facet and is dropped.
 */
export const SUBJECT_FACETS: readonly SubjectFacetEntry[] = [
  // BISAC categories: a self-declared genre taxonomy.
  { provider: 'googlebooks', category: 'genre', extract: (p) => asStringArray(p.subjects) },
  // genres[] holds both type:'genre' and type:'tag' entries under one field name.
  { provider: 'audnexus', category: 'genre', extract: (p) => asStringArray(p.subjects) },
  // P136, whose property name is literally "genre".
  { provider: 'wikidata', category: 'genre', extract: (p) => asStringArray(p.subjects) },
  // subject[] is a MARC topical heading field — "what the book is about".
  { provider: 'openlibrary', category: 'theme', extract: (p) => asStringArray(p.subjects) },
  // Read from `raw`, not the flattened `subjects` — see hardcoverFacets.
  { provider: 'hardcover', category: 'genre', extract: (p) => hardcoverFacets(p.raw).genres },
  { provider: 'hardcover', category: 'mood', extract: (p) => hardcoverFacets(p.raw).moods },
];

const FACETS_BY_PROVIDER = new Map<string, SubjectFacetEntry[]>();
for (const entry of SUBJECT_FACETS) {
  const list = FACETS_BY_PROVIDER.get(entry.provider);
  if (list) list.push(entry);
  else FACETS_BY_PROVIDER.set(entry.provider, [entry]);
}

/** Facet entries for `provider`, or `[]` for a provider with no entry in the
 *  table — fail closed, never guess a category for an unknown provider. */
export function facetsForProvider(provider: string): readonly SubjectFacetEntry[] {
  return FACETS_BY_PROVIDER.get(provider) ?? [];
}
