/**
 * Judges whether a book's stored tags are current, and — the whole point of
 * splitting the hash in `tagInputs.ts` — whether refreshing them costs an
 * LLM call or nothing at all.
 *
 * Shaped deliberately like `retrieval/embedder.ts`'s `isEmbeddingStale` /
 * `staleReason` pair, because it is the same idea one step earlier in the
 * pipeline: a pure comparison against stored identity, no event hooks, and
 * self-healing on the next run regardless of what caused the drift.
 *
 * It differs from the embedding case in one respect that matters to the
 * caller: staleness here is not a single verdict. `isEmbeddingStale`
 * deliberately collapses its three conditions because the caller does the
 * same work either way. Here the caller does NOT — a `reground` costs
 * milliseconds and a `retag` costs a model call and real money — so `kind`
 * is reported alongside `reason` and must never be collapsed into it.
 */
import type { Book } from '../types.js';

/** Why a book is not current. Ordered most- to least-severe in `judgeTagFreshness`. */
export type TagStaleReason =
  /** No `book_tags` rows at all. */
  | 'never-tagged'
  /**
   * Tagged, but the run stored no input hashes — every run that predates
   * this mechanism. We know it WAS tagged and cannot honestly say against
   * what, so it is reported stale rather than assumed fresh. Same rule as
   * `getReadinessCounts`' `taggedVersionUnknown`: a check that cannot
   * succeed says so, it does not return a confident number.
   */
  | 'never-recorded'
  | 'schema-changed'
  /** The bytes sent to the model changed (description backfill, retitle, …). */
  | 'prompt-changed'
  /** Only local compose inputs moved: entities, vocabulary, aliases, derived tags. */
  | 'compose-changed';

/**
 * How to make a stale book current. `reground` recomposes from the stored
 * proposals with no network; `retag` calls the model.
 */
export type TagRefreshKind = 'reground' | 'retag';

/** One book's stored tagging identity, as returned by `db.getTagStaleCandidates`. */
export interface TagStaleCandidate {
  book: Book;
  /** True when the book has at least one `book_tags` row. */
  hasTags: boolean;
  /** Null when the book has no `tag_runs` row, or its newest run predates the hash columns. */
  storedPromptHash: string | null;
  storedComposeHash: string | null;
  storedSchemaVersion: number | null;
  /** True when the newest run stored raw proposals — the precondition for `reground`. */
  hasProposals: boolean;
}

export interface TagFreshnessVerdict {
  bookId: string;
  title: string;
  reason: TagStaleReason;
  kind: TagRefreshKind;
}

/**
 * Compare a candidate against freshly computed hashes.
 *
 * Returns `null` for a current book. Checks run most- to least-severe and
 * stop at the first hit, so a book whose description was backfilled reports
 * `prompt-changed` (paid) rather than the `compose-changed` (free) that is
 * also true of it — the cheaper verdict would recompose proposals the model
 * made without ever seeing that description, quietly producing a tag set
 * nobody would have got by running the pipeline forward.
 */
export function judgeTagFreshness(
  candidate: TagStaleCandidate,
  promptHash: string,
  composeHash: string,
  schemaVersion: number
): TagFreshnessVerdict | null {
  const base = { bookId: candidate.book.id, title: candidate.book.title };

  if (!candidate.hasTags) return { ...base, reason: 'never-tagged', kind: 'retag' };
  if (candidate.storedPromptHash === null || candidate.storedComposeHash === null) {
    return { ...base, reason: 'never-recorded', kind: 'retag' };
  }
  if (candidate.storedSchemaVersion !== schemaVersion) {
    return { ...base, reason: 'schema-changed', kind: 'retag' };
  }
  if (candidate.storedPromptHash !== promptHash) {
    return { ...base, reason: 'prompt-changed', kind: 'retag' };
  }
  if (candidate.storedComposeHash !== composeHash) {
    // The only reason that can ever be free — and only when the proposals
    // needed to recompose were actually kept. Without them the sole way back
    // to a correct tag set is to ask the model again, so this reports
    // `retag` rather than promising a `reground` that would have nothing to
    // ground.
    return { ...base, reason: 'compose-changed', kind: candidate.hasProposals ? 'reground' : 'retag' };
  }
  return null;
}
