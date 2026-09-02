/**
 * Book card composition (librarian engine plan, Phase 3 retrieval layer).
 *
 * A "card" is a composed plain-text representation of one book, fed verbatim
 * to a text-embedding model — it is the literal text the embedder sees, which
 * is what makes abstract vibe queries (e.g. "melancholic coastal autumn")
 * work: the card contains lines like `mood: melancholic, wistful` and
 * `setting: coastal-town, autumn` in the embedder's own input.
 *
 * Composition is pure and deterministic (no I/O, no clock reads) so the same
 * (book, tags, entities) always produces byte-identical text and therefore
 * the same {@link cardHash}, which drives re-embedding via
 * `book_embeddings.card_hash`.
 *
 * Tags of every {@link TagSource} — including 'llm-open' — are included. The
 * card exists purely for semantic attraction; trust-tier filtering of tags
 * happens elsewhere (structured search / hard filters), not here.
 *
 * Sort tiebreaks throughout use plain codepoint comparison (`a < b`), never
 * `localeCompare` — ICU collation can differ across Node/ICU builds (the
 * container image and a developer's local Node are not guaranteed to match),
 * and this hash is a persisted column (`book_embeddings.card_hash`) that
 * must stay stable across environments, not just within one process.
 *
 * ── Narrator line (R3, docs/enrichment-sources-review.md §3) ────────────────
 * Narrator/production style is the one retrieval axis no text-only book
 * source can ever supply — worth a dedicated line even though it costs zero
 * new fetches (`books.narrator` is populated from cached ABS/Audnexus data
 * only; see `enrichment/narratorBackfill.ts`). Placed directly after `Series`
 * and before the tag-category block: it is bibliographic metadata about
 * *this edition* (who performed it), the same family as Title/Author/Series,
 * not a semantic/vibe facet like the tag lines that follow. Emitted as
 * `Narrator: Name1, Name2` in the order `book.narrator` already carries — the
 * one list on this card NOT re-sorted here — because that order is itself
 * meaningful (billing/casting order from the source) and, unlike tags or
 * entities, is already deterministic on entry: it comes from one decoded JSON
 * column, not a query result whose row order is incidental. A single
 * narrator and a multi-narrator (full-cast) list therefore render
 * differently on purpose — `Narrator: R.C. Bray` vs `Narrator: A, B, C` — so
 * a full-cast production is distinguishable from a solo one directly in the
 * embedder's input, per the spec's "store the list, not a joined string"
 * instruction. Adding this line invalidates `card_hash` for every book that
 * already has a narrator — intended, per §5 of the spec: it is the re-embed
 * trigger, not a bug.
 */
import { createHash } from 'node:crypto';

import type { CuratorDb } from '../db.js';
import type { EntityKind } from '../enrichment/types.js';
import { TAG_CATEGORIES } from '../types.js';
import type { Book, BookEntity, BookTag } from '../types.js';

export interface BookCard {
  bookId: string;
  /** The composed card text fed to the embedder. */
  text: string;
  /** Stable content hash of `text`; drives re-embedding (book_embeddings.card_hash). */
  hash: string;
}

export interface ComposeCardOptions {
  /** Max characters of description included. Default 800. A value <= 0
   *  omits the Description line entirely, rather than emitting an empty or
   *  (for negative values) nonsensical excerpt. */
  descriptionChars?: number;
}

const DEFAULT_DESCRIPTION_CHARS = 800;

/** Entity kind → card label. A `Record` (not a partial map) so adding a new
 *  `EntityKind` fails the build until it is given a label here — a bare
 *  array of pairs would silently drop entities of the new kind instead. */
const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  person: 'People',
  place: 'Places',
  time: 'Times',
};

/** Fixed emission order, derived from the (ordered) labels object above. */
const ENTITY_KIND_ORDER = Object.keys(ENTITY_KIND_LABELS) as EntityKind[];

/** Plain codepoint comparator — see the module docblock for why not `localeCompare`. */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapse all whitespace runs (including newlines) to single spaces and trim. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Truncate `text` (already whitespace-collapsed) to at most `maxChars`
 * characters, cutting at the last whitespace boundary at or before the
 * limit and appending a single ellipsis. Text at or under the limit is
 * returned unchanged.
 *
 * If no whitespace exists within the first `maxChars` characters (e.g. one
 * very long unbroken token), the whitespace-boundary contract degrades to a
 * hard cut at `maxChars`. Either way, the cut point is backed off by one
 * code unit when it would land inside a UTF-16 surrogate pair, so the
 * emitted text never contains a lone (unpaired) surrogate.
 */
function truncateDescription(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cutAt = maxChars;
  const boundaryCode = text.charCodeAt(cutAt - 1);
  if (boundaryCode >= HIGH_SURROGATE_MIN && boundaryCode <= HIGH_SURROGATE_MAX) cutAt -= 1;
  const slice = text.slice(0, cutAt);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/** SHA-256 hex digest of the card text. Exported so callers can re-hash without recomposing. */
export function cardHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Compose a card from already-loaded parts. Pure, deterministic, no I/O. */
export function composeBookCard(
  book: Book,
  tags: readonly BookTag[],
  entities: readonly BookEntity[],
  options?: ComposeCardOptions
): BookCard {
  const descriptionChars = options?.descriptionChars ?? DEFAULT_DESCRIPTION_CHARS;
  const lines: string[] = [];

  lines.push(`Title: ${collapseWhitespace(book.title)}`);

  const author = book.author ? collapseWhitespace(book.author) : '';
  if (author) lines.push(`Author: ${author}`);

  const series = book.series ? collapseWhitespace(book.series) : '';
  if (series) {
    lines.push(
      book.seriesSequence != null ? `Series: ${series}, Book ${book.seriesSequence}` : `Series: ${series}`
    );
  }

  // See the module docblock ("Narrator line") for why this sits here, why it
  // is NOT re-sorted, and why adding it is a deliberate card_hash-invalidating
  // change. `book.narrator` is already null-vs-empty normalized by `mapBook`
  // (never `[]`), so the length check alone is enough to skip "no narrator
  // known" — nothing here needs to special-case an empty array separately.
  if (book.narrator && book.narrator.length > 0) {
    const narrators = book.narrator.map((n) => collapseWhitespace(n)).filter((n) => n.length > 0);
    if (narrators.length > 0) lines.push(`Narrator: ${narrators.join(', ')}`);
  }

  for (const category of TAG_CATEGORIES) {
    const inCategory = tags.filter((t) => t.category === category);
    if (inCategory.length === 0) continue;
    // Compute the rendered label once and sort/join on that exact value —
    // never a lossy derivative of it (e.g. lowercased) — so the sort key
    // always agrees with what actually appears in the text.
    const labeled = inCategory.map((t) => ({ confidence: t.confidence, label: collapseWhitespace(t.tag) }));
    const sorted = labeled.sort(
      (a, b) => b.confidence - a.confidence || compareCodepoint(a.label, b.label)
    );
    lines.push(`${category}: ${sorted.map((t) => t.label).join(', ')}`);
  }

  for (const kind of ENTITY_KIND_ORDER) {
    // Notable-only: the card is a presentation surface, and a large
    // concordance-style allowlist (hundreds of entries for a book like "It")
    // would drown the card's actual semantic signal (mood/setting lines) —
    // see enrichment/entityNotability.ts. This means a book's card text (and
    // therefore card_hash) changes the moment its entities are re-scored,
    // which getStaleEmbeddings picks up automatically as a re-embed
    // candidate — that's intended, not a bug to "fix" by caching around it.
    const inKind = entities.filter((e) => e.kind === kind && e.notable);
    if (inKind.length === 0) continue;
    const labels = inKind.map((e) => collapseWhitespace(e.entity));
    const sorted = labels.sort((a, b) => {
      const primary = compareCodepoint(a.toLowerCase(), b.toLowerCase());
      // Case-insensitive primary key can't distinguish two entities that
      // differ only in case (or only in whitespace collapsed away above);
      // fall back to the exact rendered label so the order — and hence the
      // hash — never depends on input array order.
      return primary !== 0 ? primary : compareCodepoint(a, b);
    });
    lines.push(`${ENTITY_KIND_LABELS[kind]}: ${sorted.join(', ')}`);
  }

  const description = book.description ? collapseWhitespace(book.description) : '';
  if (description && descriptionChars > 0) {
    lines.push(`Description: ${truncateDescription(description, descriptionChars)}`);
  }

  const text = lines.join('\n');
  return { bookId: book.id, text, hash: cardHash(text) };
}

/**
 * Load the book's tags + entities from the db and compose its card.
 * Returns null when the book id is unknown.
 */
export function composeBookCardFromDb(
  db: CuratorDb,
  bookId: string,
  options?: ComposeCardOptions
): BookCard | null {
  const book = db.getBook(bookId);
  if (!book) return null;
  const tags = db.getTagsForBook(bookId);
  const entities = db.getEntitiesForBook(bookId);
  return composeBookCard(book, tags, entities, options);
}
