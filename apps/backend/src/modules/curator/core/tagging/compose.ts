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
import type { Book, GeneratedTag, TagCategory } from '../types.js';
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
  const grounded = groundEntityTags(entityTags, db.getEntitiesForBook(book.id), book.description);
  const canonical = canonicalizeTags(otherTags, db);

  const rest = [...canonical, ...grounded].filter(
    (t) => !claimedCategories.has(t.category) && !derivedTagStrings.has(t.tag)
  );

  return [...derived, ...rest];
}
