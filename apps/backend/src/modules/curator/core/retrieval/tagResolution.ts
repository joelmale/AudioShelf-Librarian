/**
 * Resolve caller-supplied tag filters against the vocabulary the library
 * actually uses, before they become SQL predicates in `db.queryBooks`.
 *
 * WHY THIS EXISTS. Every caller of the librarian tools supplies tag filters as
 * free text: `recommendations.ts` gets them from a planner LLM, and
 * `librarian/driver.ts` dispatches tool arguments the answering model wrote
 * itself. Tags are stored kebab-case and canonicalized against `vocab_terms`
 * (see `../tagging/canonicalize.ts`), so a filter like `murder mystery` is not
 * a strict constraint that happens to match nothing — it is a predicate that
 * can never match anything, for any library, because no stored tag contains a
 * space. The Key West acceptance failure (§10.C Q1) was exactly this: a hard
 * `murder mystery` genre filter emptied the candidate set, and the answering
 * model, handed no evidence, invented a book — which `driver.ts` then
 * correctly rejected two steps downstream from the actual fault.
 *
 * THIS IS NOT A SOFTENING OF THE HARD-FILTER INVARIANT. `tools.ts` documents
 * `allTags`/`anyTags`/`excludeTags` as absolute, and they stay absolute.
 * Resolving `murder mystery` to the canonical `mystery` makes the filter mean
 * what the caller said instead of guaranteeing an empty set; it changes which
 * books satisfy the constraint, never whether the constraint is enforced.
 *
 * EXPANSION IS ASYMMETRIC, AND DELIBERATELY SO.
 *   - `anyTags`, `excludeTags`, `preferredTags`, `softExcludeTags` are OR-shaped
 *     or weighted, so a canonical term expands to its SUBTYPES: library tags
 *     whose token set contains every token of the canonical term
 *     (`mystery` -> `comedy-mystery`, `humorous-mystery`). That is a true is-a
 *     relationship, so it holds for a ban as well as for a preference —
 *     "no thrillers" genuinely means no `psychological-thriller`.
 *   - `allTags` is AND-shaped: each entry becomes its own conjunct in
 *     `db.queryBooks`, and an AND-of-ORs is not expressible there. It is
 *     therefore canonicalized but NEVER expanded. Callers that want a family
 *     to compete should route it through `preferredTags` — which is also the
 *     policy `recommendations.ts` now applies to every positive tag, for the
 *     coverage reason argued in `docs/recommendation-data-model.md` §8.
 *
 * Every change is reported in {@link TagResolutionNote}s so the caller can
 * disclose it. Nothing here silently truncates: hitting the field cap emits a
 * note of its own.
 */
import type { CuratorDb } from '../db.js';
import { canonicalizeTags, normalizeTagForm } from '../tagging/canonicalize.js';
import type { TagCategory } from '../types.js';

export interface TagFilterInput {
  tag: string;
  category?: TagCategory;
}

export interface WeightedTagFilterInput extends TagFilterInput {
  weight?: number;
}

export type ResolvedTagField =
  | 'allTags'
  | 'relaxableTags'
  | 'anyTags'
  | 'excludeTags'
  | 'preferredTags'
  | 'softExcludeTags'
  | 'tag';

/** One disclosed change: what the caller asked for, and what actually ran. */
export interface TagResolutionNote {
  field: ResolvedTagField;
  from: string;
  to: string[];
  reason: string;
}

export interface ResolveTagFiltersInput {
  allTags?: readonly TagFilterInput[];
  relaxableTags?: readonly TagFilterInput[];
  anyTags?: readonly TagFilterInput[];
  excludeTags?: readonly TagFilterInput[];
  preferredTags?: readonly WeightedTagFilterInput[];
  softExcludeTags?: readonly WeightedTagFilterInput[];
}

export interface ResolvedTagFilters {
  allTags?: TagFilterInput[];
  relaxableTags?: TagFilterInput[];
  anyTags?: TagFilterInput[];
  excludeTags?: TagFilterInput[];
  preferredTags?: WeightedTagFilterInput[];
  softExcludeTags?: WeightedTagFilterInput[];
  notes: TagResolutionNote[];
  /** Hard fields containing a tag that normalized to nothing. Callers must
   *  fail closed rather than silently deleting that predicate. */
  invalidHardFields: Array<'allTags' | 'relaxableTags' | 'anyTags' | 'excludeTags'>;
}

/** Tokens this short carry no subtype meaning (`of`, `a`, `up`). */
const SIGNIFICANT_TOKEN_MIN = 3;
/** Subtypes admitted per canonical term, most-used first. */
const EXPANSION_LIMIT = 6;
/** Weight a subtype gets relative to the exact term the caller named. */
const SUBTYPE_WEIGHT_RATIO = 0.5;
/** Mirrors `MAX_FILTER_ITEMS` in `librarian/tools.ts` — expansion must not
 *  push a field past the schema bound the tool will validate it against. */
const MAX_RESOLVED_ITEMS = 50;

interface VocabEntry {
  tag: string;
  category: TagCategory;
  count: number;
}

function tokensOf(term: string): string[] {
  return term.split('-').filter((token) => token.length > 0);
}

function significantTokens(term: string): string[] {
  return tokensOf(term).filter((token) => token.length >= SIGNIFICANT_TOKEN_MIN);
}

/**
 * The category a bare tag belongs to, inferred from the library itself.
 *
 * Same uniqueness rule as `db.resolveTagCategory` and `canonicalize.ts`'s
 * single-token fallback: answer only when exactly one category qualifies. Two
 * qualifying categories means we cannot tell which the caller meant, and
 * guessing would silently retarget their filter.
 */
function inferCategory(vocab: readonly VocabEntry[], norm: string): TagCategory | undefined {
  const exact = new Set(vocab.filter((entry) => entry.tag === norm).map((entry) => entry.category));
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) return undefined;

  // `murder-mystery` is in no vocabulary, but its `mystery` token is. Accept
  // that only when exactly one (token, category) pair across the whole term
  // qualifies — the same refusal-to-guess rule one level down.
  const viaToken = new Set<string>();
  for (const token of significantTokens(norm)) {
    for (const entry of vocab) {
      if (entry.tag === token) viaToken.add(`${entry.category}`);
    }
  }
  return viaToken.size === 1 ? ([...viaToken][0] as TagCategory) : undefined;
}

/** Canonical stored form of one caller-supplied tag, or `''` if it normalizes away. */
function canonicalForm(
  db: CuratorDb,
  vocab: readonly VocabEntry[],
  filter: TagFilterInput,
): { tag: string; category?: TagCategory } {
  const norm = normalizeTagForm(filter.tag);
  if (norm === '') return { tag: '' };

  const category = filter.category ?? inferCategory(vocab, norm);
  // No category means no vocabulary scope to canonicalize against — the
  // normalized surface form is the most we can honestly claim.
  if (category === undefined) return { tag: norm };

  const [resolved] = canonicalizeTags([{ tag: norm, category, confidence: 1 }], db);
  return {
    tag: resolved ? resolved.tag : norm,
    // Only report a category the caller actually gave us. An inferred one is
    // good enough to canonicalize against but must not narrow their filter.
    ...(filter.category !== undefined ? { category: filter.category } : {}),
  };
}

/**
 * Library tags that are subtypes of `canonical` — every significant token of
 * `canonical` appears among the candidate's tokens, and the candidate is a
 * different (longer) term. Most-used first, so a cap keeps the useful ones.
 */
function subtypesOf(
  vocab: readonly VocabEntry[],
  canonical: string,
  category: TagCategory | undefined,
): string[] {
  const want = significantTokens(canonical);
  if (want.length === 0) return [];
  return vocab
    .filter((entry) => category === undefined || entry.category === category)
    .filter((entry) => entry.tag !== canonical)
    .filter((entry) => {
      const have = new Set(tokensOf(entry.tag));
      return want.every((token) => have.has(token));
    })
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, EXPANSION_LIMIT)
    .map((entry) => entry.tag);
}

/** Keep the highest weight per (category, tag); preserve first-seen order. */
function dedupe<T extends WeightedTagFilterInput>(entries: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = `${entry.category ?? ''} ${entry.tag}`;
    const existing = byKey.get(key);
    if (!existing || (entry.weight ?? 1) > (existing.weight ?? 1)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function capField<T>(field: ResolvedTagField, entries: T[], notes: TagResolutionNote[]): T[] {
  if (entries.length <= MAX_RESOLVED_ITEMS) return entries;
  notes.push({
    field,
    from: `${entries.length} resolved terms`,
    to: [`${MAX_RESOLVED_ITEMS} kept`],
    reason: 'Resolution exceeded the tool filter cap; the least-used terms were dropped',
  });
  return entries.slice(0, MAX_RESOLVED_ITEMS);
}

function describe(filter: TagFilterInput): string {
  return filter.category ? `${filter.category}:${filter.tag}` : filter.tag;
}

/**
 * Resolve one field's worth of filters. `expand` controls whether a canonical
 * term also pulls in its subtypes — see the module docblock for why that is
 * safe for OR-shaped and weighted fields but not for `allTags`.
 */
function resolveField<T extends WeightedTagFilterInput>(
  db: CuratorDb,
  vocab: readonly VocabEntry[],
  field: ResolvedTagField,
  filters: readonly T[] | undefined,
  expand: boolean,
  notes: TagResolutionNote[],
  cap = true,
): WeightedTagFilterInput[] | undefined {
  if (!filters || filters.length === 0) return undefined;

  const out: WeightedTagFilterInput[] = [];
  for (const filter of filters) {
    const canonical = canonicalForm(db, vocab, filter);
    if (canonical.tag === '') {
      notes.push({
        field,
        from: describe(filter),
        to: [],
        reason: 'Normalized to an empty tag and was dropped',
      });
      continue;
    }

    const weight = filter.weight;
    const base: WeightedTagFilterInput = {
      tag: canonical.tag,
      ...(canonical.category !== undefined ? { category: canonical.category } : {}),
      ...(weight !== undefined ? { weight } : {}),
    };
    out.push(base);

    const inferredCategory = inferCategory(vocab, normalizeTagForm(filter.tag));
    const category = filter.category ?? inferredCategory;
    // An unqualified term present in multiple categories has no honest scope.
    // Keep its normalized base term, but do not widen it across every category.
    const subtypes = expand && category !== undefined ? subtypesOf(vocab, canonical.tag, category) : [];
    for (const subtype of subtypes) {
      out.push({
        tag: subtype,
        ...(canonical.category !== undefined ? { category: canonical.category } : {}),
        weight: (weight ?? 1) * SUBTYPE_WEIGHT_RATIO,
      });
    }

    const changed = canonical.tag !== filter.tag;
    if (changed || subtypes.length > 0) {
      notes.push({
        field,
        from: describe(filter),
        to: [canonical.tag, ...subtypes],
        reason: subtypes.length > 0
          ? (changed
            ? 'Resolved to a library vocabulary term and widened to its subtypes'
            : 'Widened to the subtypes the library actually uses')
          : 'Resolved to the library vocabulary term',
      });
    }
  }

  const deduped = dedupe(out);
  return cap ? capField(field, deduped, notes) : deduped;
}

/** Drop the `weight` key from fields whose schema does not accept one. */
function unweighted(entries: WeightedTagFilterInput[] | undefined): TagFilterInput[] | undefined {
  return entries?.map(({ tag, category }) => ({
    tag,
    ...(category !== undefined ? { category } : {}),
  }));
}

/**
 * Resolve every tag filter on a librarian retrieval call. Returns only the
 * fields the caller actually supplied, so a spread of the result cannot
 * introduce a filter the caller never asked for.
 */
export function resolveTagFilters(db: CuratorDb, input: ResolveTagFiltersInput): ResolvedTagFilters {
  const vocab = db.getTagVocabulary();
  const notes: TagResolutionNote[] = [];

  // `allTags` is the one field that must not widen — see the module docblock.
  const allTags = unweighted(resolveField(db, vocab, 'allTags', input.allTags, false, notes));
  // Relaxable tags are strict on the first pass, so they must not widen until
  // search_semantic deliberately demotes them into preferredTags.
  const relaxableTags = unweighted(resolveField(db, vocab, 'relaxableTags', input.relaxableTags, false, notes));
  const anyTags = unweighted(resolveField(db, vocab, 'anyTags', input.anyTags, true, notes));
  // Hard exclusions are never capped: dropping a later predicate would turn
  // an explicit ban into a silent inclusion. Fifty caller terms with bounded
  // subtype expansion remain safely below SQLite's parameter ceiling.
  const excludeTags = unweighted(resolveField(db, vocab, 'excludeTags', input.excludeTags, true, notes, false));
  const preferredTags = resolveField(db, vocab, 'preferredTags', input.preferredTags, true, notes);
  const softExcludeTags = resolveField(db, vocab, 'softExcludeTags', input.softExcludeTags, true, notes);

  return {
    ...(allTags !== undefined ? { allTags } : {}),
    ...(relaxableTags !== undefined ? { relaxableTags } : {}),
    ...(anyTags !== undefined ? { anyTags } : {}),
    ...(excludeTags !== undefined ? { excludeTags } : {}),
    ...(preferredTags !== undefined ? { preferredTags } : {}),
    ...(softExcludeTags !== undefined ? { softExcludeTags } : {}),
    notes,
    invalidHardFields: (['allTags', 'relaxableTags', 'anyTags', 'excludeTags'] as const)
      .filter((field) => input[field]?.some((entry) => normalizeTagForm(entry.tag) === '')),
  };
}

/**
 * Canonicalize the single `tag` of a `search_library` call. That tool is the
 * exact-structured-lookup surface, so its term is resolved but never widened.
 */
export function resolveSingleTag(
  db: CuratorDb,
  tag: string,
  category: TagCategory | undefined,
): { tag: string; note: TagResolutionNote | null } {
  const vocab = db.getTagVocabulary();
  const canonical = canonicalForm(db, vocab, { tag, ...(category !== undefined ? { category } : {}) });
  if (canonical.tag === '' || canonical.tag === tag) return { tag, note: null };
  return {
    tag: canonical.tag,
    note: {
      field: 'tag',
      from: category ? `${category}:${tag}` : tag,
      to: [canonical.tag],
      reason: 'Resolved to the library vocabulary term',
    },
  };
}
