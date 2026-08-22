/**
 * Composes the final persisted tag set for one book from raw LLM output
 * (librarian engine plan §3, full propose -> canonicalize -> ground ->
 * derive pipeline). Shared by `tagger.ts` (bulk run) and the MCP
 * `retag_book` tool (single-book re-tag) so both call sites apply the exact
 * same rules — see `./canonicalize.ts` and `./ground.ts` for the individual
 * steps.
 *
 * Precedence, in order: `derived` tags (length/era, computed from metadata)
 * always win their category; everything else is the union of canonicalized
 * non-entity tags and grounded character/setting tags, with any tag whose
 * category was already claimed by a derived tag dropped.
 */
import { deriveTags } from '../derivedTags.js';
import type { CuratorDb } from '../db.js';
import type { Book, GeneratedTag, TagCategory } from '../types.js';
import { canonicalizeTags, type CanonicalTag } from './canonicalize.js';
import { groundEntityTags } from './ground.js';

const ENTITY_CATEGORIES = new Set<TagCategory>(['character', 'setting']);

/** Canonicalize + ground + derive the persisted tag set for `book` from raw `llmTags`. */
export function composeBookTags(book: Book, llmTags: GeneratedTag[], db: CuratorDb): CanonicalTag[] {
  const derived = deriveTags(book);
  const derivedCategories = new Set(derived.map((t) => t.category));

  const entityTags = llmTags.filter((t) => ENTITY_CATEGORIES.has(t.category));
  const otherTags = llmTags.filter((t) => !ENTITY_CATEGORIES.has(t.category));

  const grounded = groundEntityTags(entityTags, db.getEntitiesForBook(book.id), book.description);
  const canonical = canonicalizeTags(otherTags, db);

  const rest = [...canonical, ...grounded].filter((t) => !derivedCategories.has(t.category));

  return [...derived, ...rest];
}
