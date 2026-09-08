/**
 * The two hashes that make tag staleness queryable — the tagging half of
 * decision #9 (docs/architecture/decisions.md, "Staleness is queryable, not
 * event-driven"), and the reason a grounding improvement no longer costs a
 * library-wide LLM re-tag.
 *
 * Tagging has the same expensive/cheap split `external_metadata` was built
 * around (see `enrichment/rederive.ts`): one paid LLM call produces raw tag
 * proposals, then `tagging/compose.ts` turns those into the persisted tag
 * set using nothing but local state — entities, vocabulary, aliases, derived
 * metadata. Those two halves go stale for completely different reasons and
 * cost wildly different amounts to redo, so ONE hash cannot describe them:
 *
 *  - `promptHash` covers what the model was asked. Drift here can only be
 *    resolved by asking again — a real API call per book.
 *  - `composeHash` covers everything `composeBookTags` reads BESIDES the
 *    proposals. Drift here is resolved by recomposing from the stored
 *    proposals: no network, no tokens, milliseconds per book.
 *
 * Collapsing them would bill a full re-tag for the common case. A single
 * re-derive pass moved 710 cached rows' entities without touching one
 * subject; under one hash that improvement costs ~950 LLM calls to apply,
 * which is exactly the "bad reason to leave a known-wrong extraction in
 * place" that `rederive.ts` exists to refuse.
 *
 * Both hashes are over COMPOSED OUTPUT wherever possible, not over a list of
 * input field names: `promptHash` hashes the actual prompt bytes and
 * `composeHash` hashes `deriveTags`' actual output. A hash over a restated
 * list of "fields that matter" drifts silently the first time a field is
 * added to either producer, and a silent freshness claim is the invariant-5
 * failure this whole mechanism exists to prevent.
 */
import { createHash } from 'node:crypto';

import { deriveTags } from '../derivedTags.js';
import { suppressedKeys } from './compose.js';
import { resolveDescription } from '../enrichment/descriptionText.js';
import { buildTagPrompt } from '../llmClient.js';
import type { Book, BookEntity, GeneratedTag, TagSuppression } from '../types.js';

/**
 * A library-wide digest of the vocabulary and alias tables.
 *
 * Canonicalization consults `isVocabTerm`/`getTagAlias` per tag, so a
 * promotion, rejection or new alias can change the composed tag set of any
 * book in the library. There is no per-book slice of that state to hash —
 * the term a given book's proposals would hit is not knowable without
 * running canonicalization — so this is deliberately one fingerprint shared
 * by every book's `composeHash`.
 *
 * The cost of that coarseness is that a single vocab edit marks the whole
 * library compose-stale. That is affordable precisely because recomposing is
 * free, and `reground.ts` writes only the books whose tags actually move —
 * so a no-op sweep costs CPU, never tokens and never a spurious re-embed.
 */
export function vocabularyFingerprint(rows: ReadonlyArray<readonly [string, string, string]>): string {
  const h = createHash('sha256');
  for (const [a, b, c] of rows) h.update(`${a}\u0000${b}\u0000${c}\u0001`, 'utf8');
  return h.digest('hex');
}

/**
 * Hash of the exact prompt bytes, the model that will answer them, and the
 * tag schema version.
 *
 * The model id belongs here for the same reason `book_embeddings.card_hash`
 * is paired with a model column: output from a different model is not
 * interchangeable with output from the configured one. The schema version
 * belongs here because a new category changes what the run could even
 * attempt, and `tag_runs` already treats that as a coverage-relevant fact.
 */
export function tagPromptHash(book: Book, model: string, schemaVersion: number): string {
  const { system, user } = buildTagPrompt(book);
  return createHash('sha256')
    .update(`${system}\u0000${user}\u0000${model}\u0000${schemaVersion}`, 'utf8')
    .digest('hex');
}

/**
 * Hash of every input `composeBookTags` reads other than the raw proposals:
 * derived tags, the grounding allowlist, the resolved description, the
 * library vocabulary fingerprint, and this book's human suppressions.
 *
 * `sources` is included per entity because grounding writes them into
 * `book_tags.source` as `external:<providers>` — a tag whose provenance
 * changed from `external:openlibrary` to `external:openlibrary+wikidata` is
 * a genuinely different stored row, and omitting sources here would leave
 * that improvement invisible to the freshness check.
 *
 * The description appears in BOTH hashes, intentionally. `composeBookTags`
 * uses it as `groundCharacter`'s fallback and `buildTagPrompt` sends it to
 * the model, so a backfilled description really does invalidate both halves
 * — and because a stale prompt outranks a stale compose (see
 * `staleness.ts`), such a book correctly routes to a paid re-tag rather than
 * a free recompose that would re-ground proposals made without it.
 *
 * Suppressions are hashed through `suppressedKeys`, the same function the
 * filter uses, rather than over the raw rows -- so the two can never disagree
 * about what a suppression means. `suppressed_at` and `note` are deliberately
 * NOT hashed: re-suppressing an already-suppressed tag refreshes both, and
 * hashing them would mark the book stale for a decision that did not change.
 *
 * This is what makes a curator's retraction cost nothing. Recording one moves
 * `composeHash` alone, so `staleness.ts` routes the book to a free recompose
 * from stored proposals instead of a paid re-tag.
 *
 * `suppressions` is a required parameter with no default, for the same reason
 * `entities` is: a call site that forgot to pass them would hash a book as
 * though nothing were suppressed while `composeBookTags` went on dropping the
 * tag, and the book would report fresh at a hash its own tags contradict.
 * Defaulting to `[]` would make that a silent runtime bug instead of a
 * compile error.
 */
export function tagComposeHash(
  book: Book,
  entities: readonly BookEntity[],
  vocabFingerprint: string,
  suppressions: readonly TagSuppression[]
): string {
  const h = createHash('sha256');

  // Hash deriveTags' OUTPUT, not book.publishedYear/durationSeconds/etc. —
  // a new derivation rule then invalidates on its own, with nothing to
  // remember to update here.
  const derived = deriveTags(book)
    .map((t) => `${t.category}\u0000${t.tag}`)
    .sort();
  for (const line of derived) h.update(`d\u0000${line}\u0001`, 'utf8');

  // `getEntitiesForBook` already orders by (kind, entity); sort anyway so
  // the hash never depends on a query plan.
  const rows = entities
    .map((e) => `${e.kind}\u0000${e.entity}\u0000${[...e.sources].sort().join('+')}`)
    .sort();
  for (const line of rows) h.update(`e\u0000${line}\u0001`, 'utf8');

  h.update(`x\u0000${resolveDescription(book).text ?? ''}\u0001`, 'utf8');
  h.update(`v\u0000${vocabFingerprint}\u0001`, 'utf8');

  for (const key of [...suppressedKeys(suppressions)].sort()) h.update(`s\u0000${key}\u0001`, 'utf8');

  return h.digest('hex');
}

/** Stable serialization of raw LLM proposals for the `tag_runs.proposals` column. */
export function serializeProposals(tags: readonly GeneratedTag[]): string {
  return JSON.stringify(tags.map((t) => ({ tag: t.tag, category: t.category, confidence: t.confidence })));
}

/**
 * Parse a stored `tag_runs.proposals` payload.
 *
 * Returns `null` — never `[]` — for a missing or unreadable payload. An
 * empty array is a real, meaningful answer ("the model proposed nothing"),
 * and a caller that cannot distinguish it from "no proposals were stored"
 * would silently recompose a book down to derived tags only.
 */
export function parseProposals(raw: string | null): GeneratedTag[] | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: GeneratedTag[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.tag !== 'string' || typeof rec.category !== 'string') continue;
      out.push({
        tag: rec.tag,
        category: rec.category as GeneratedTag['category'],
        confidence: typeof rec.confidence === 'number' ? rec.confidence : 0,
      });
    }
    return out;
  } catch {
    return null;
  }
}
