/**
 * Composes the final persisted tag set for one book from raw LLM output
 * (librarian engine plan §3, full propose -> canonicalize -> ground ->
 * derive pipeline). Shared by `tagger.ts` (bulk run) and the MCP
 * `retag_book` tool (single-book re-tag) so both call sites apply the exact
 * same rules — see `./canonicalize.ts` and `./ground.ts` for the individual
 * steps.
 *
 * Precedence: `derived` tags (computed from metadata) always outrank LLM
 * output, but they only *suppress* an LLM tag when the category is
 * single-valued — length and era, per EXCLUSIVE_DERIVED_CATEGORIES. Derived
 * tags in any other category merge alongside the LLM's, because a
 * `full-cast` production and a `multi-pov` narrative are both true of the
 * same book. Everything else is the union of canonicalized non-entity tags
 * and grounded character/setting tags.
 */
import { deriveTags, EXCLUSIVE_DERIVED_CATEGORIES } from '../derivedTags.js';
import type { CuratorDb } from '../db.js';
import { resolveDescription } from '../enrichment/descriptionText.js';
import { TAG_CATEGORIES, type Book, type BookEntity, type GeneratedTag, type TagCategory } from '../types.js';
import { canonicalizeTags, type CanonicalTag } from './canonicalize.js';
import { groundEntityTags } from './ground.js';

const ENTITY_CATEGORIES = new Set<TagCategory>(['character', 'setting']);

/** Canonicalize + ground + derive the persisted tag set for `book` from raw `llmTags`. */
export function composeBookTags(book: Book, llmTags: GeneratedTag[], db: CuratorDb): CanonicalTag[] {
  const derived = deriveTags(book);
  const claimedCategories = new Set(
    derived.filter((t) => EXCLUSIVE_DERIVED_CATEGORIES.has(t.category)).map((t) => t.category)
  );
  // `book_tags` is unique on (book_id, tag), not (book_id, tag, category), so
  // an LLM tag with the same string as a derived one would overwrite it on
  // insert and demote its source. Drop those regardless of category.
  const derivedTagStrings = new Set(derived.map((t) => t.tag));

  const entityTags = llmTags.filter((t) => ENTITY_CATEGORIES.has(t.category));
  const otherTags = llmTags.filter((t) => !ENTITY_CATEGORIES.has(t.category));

  // Deliberately the FULL allowlist, not { notableOnly: true }. Grounding is
  // a validation step — it needs every entity a provider ever confirmed to
  // reject a fabricated character, and a 697-entry concordance list rejects
  // fabrications exactly as well as a 5-entry cast list. Narrowing this to
  // notable-only would silently reopen the hallucination hole entityNotability.ts
  // was never meant to touch: see BookEntity's docblock in ../types.js.
  const grounded = groundEntityTags(entityTags, db.getEntitiesForBook(book.id), resolveDescription(book).text);
  const canonical = canonicalizeTags(otherTags, db);

  const rest = [...canonical, ...grounded].filter(
    (t) => !claimedCategories.has(t.category) && !derivedTagStrings.has(t.tag)
  );

  return [...derived, ...rest];
}

/**
 * Categories a tagging run could actually EVALUATE for `book`, given its
 * metadata and grounding inputs — as opposed to `TAG_CATEGORIES` wholesale
 * (librarian engine plan §10.A, review finding 4). This is what a call site
 * should pass to `db.recordTagRun`, so `getTagCoverage` never reports
 * `absent` for a category the pipeline was structurally incapable of
 * answering for this book.
 *
 * This is about whether the category could be CHECKED, not about whether the
 * check produced a tag — a category the LLM was asked about and returned
 * nothing for is still evaluable (and should still record as attempted, so
 * coverage reports `absent`, not `unaudited`). Narrowing this to "categories
 * that ended up with a tag" would silently turn every legitimate "checked,
 * and it doesn't apply" verdict back into "never checked", defeating the
 * whole point of `tag_runs`. Only three categories are excluded here, and
 * only when the pipeline could not have produced ANY verdict regardless of
 * what the LLM said:
 *
 *  - `era`   — never asked of the LLM (see the tag prompt in `llmClient.ts`);
 *              purely `deriveEra(book.publishedYear)`, which is undefined
 *              when `publishedYear` is null (`derivedTags.ts`).
 *  - `length` — same story, `deriveLength(book.durationSeconds)`.
 *  - `character` — `groundCharacter` (`./ground.ts`) unconditionally drops
 *              EVERY candidate, regardless of what the LLM proposed, when the
 *              book has no `person`-kind entity in its grounding allowlist
 *              AND no description to weakly substring-match against. In that
 *              case the run learns nothing about whether the book carries a
 *              character tag no matter what came back from the LLM.
 *
 * `setting` is deliberately NOT excluded even on an unenriched book:
 * `groundSetting` never drops a candidate outright — an unmatched setting is
 * kept as `llm-open` rather than rejected — so the LLM's answer (or
 * non-answer) is always a meaningful verdict.
 *
 * The `character` clause below RESTATES `groundCharacter`'s drop condition by
 * hand, in a different file. If you change either one, change both: the
 * biconditional between them is asserted in `./compose.test.ts`
 * ("evaluableTagCategories is coupled to what groundEntityTags can actually
 * do"), which fails if this exclusion is removed OR if `ground.ts`'s
 * description fallback is. Drift in the second direction is the dangerous
 * one — it would leave this function confidently claiming `character` was
 * attempted for a check that could no longer succeed.
 */
export function evaluableTagCategories(book: Book, allowlist: BookEntity[]): TagCategory[] {
  const evaluable = new Set<TagCategory>(TAG_CATEGORIES);

  if (book.publishedYear === null) evaluable.delete('era');
  if (book.durationSeconds === null) evaluable.delete('length');

  const hasPersonAllowlist = allowlist.some((e) => e.kind === 'person');
  // resolveDescription's ABS-then-harvested fallback, not raw `book.description` —
  // ground.ts's own fallback gate reads the resolved value too (see the
  // biconditional note above), so this must track exactly what `groundCharacter`
  // can actually see.
  const hasDescription = resolveDescription(book).text !== null;
  if (!hasPersonAllowlist && !hasDescription) evaluable.delete('character');

  return TAG_CATEGORIES.filter((c) => evaluable.has(c));
}
