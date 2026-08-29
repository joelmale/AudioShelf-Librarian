/**
 * Implicit feedback derived from Audiobookshelf listening progress
 * (plan §6: "finished fast = strong positive; abandoned at 10% = negative").
 *
 * WHY THIS IS THE MOST VALUABLE SIGNAL HERE. A personal library is a
 * positive-only dataset — every book in it was chosen — so nothing in
 * `books` or `book_tags` can tell the ranker what this user dislikes. The
 * abandon point is the only true negative the system will ever observe about
 * an owned book, and it is graded rather than binary: dropped at 8% is a
 * rejection, dropped at 80% is very nearly a completion and should barely
 * count against a book at all. See `docs/recommendation-data-model.md` §3.
 *
 * ── "Not finished" is not "abandoned" ──────────────────────────────────────
 * A book being read right now looks identical, in a progress snapshot, to a
 * book someone gave up on. The only thing separating them is time since the
 * last session, so nothing is called abandoned until
 * {@link ABANDON_AFTER_DAYS} of silence. Getting this wrong would punish a
 * book for the crime of being mid-listen, which is the opposite of the
 * intended signal.
 *
 * ── Restatement, not event ─────────────────────────────────────────────────
 * These verdicts describe current state, so they go through
 * `db.upsertImplicitFeedback`, which replaces the previous implicit row for
 * that book. Appending instead would let a book's weight in the taste profile
 * grow with the number of times sync happened to run.
 */
import type { FeedbackVerdict, ListeningProgress } from '../types.js';

/** Silence this long turns "in progress" into "abandoned". */
export const ABANDON_AFTER_DAYS = 60;
/**
 * At or above this fraction the listener effectively completed the book;
 * stopping at 92% is not a verdict against it.
 */
export const NEAR_COMPLETION = 0.9;
/** Below this fraction, a start is too slight to read as either verdict. */
export const MIN_MEANINGFUL_PROGRESS = 0.02;
const MS_PER_DAY = 86_400_000;

export interface ImplicitSignal {
  verdict: FeedbackVerdict;
  /** Graded strength in (0,1]. */
  weight: number;
}

/**
 * The verdict a progress snapshot implies, or `null` for "no verdict yet" —
 * never started, barely started, or still actively being listened to.
 *
 * Abandon weight is the inverse of how far they got, scaled across the
 * meaningful range: abandoning at 2% yields ~1.0, at 90% yields ~0.
 */
export function deriveImplicitSignal(progress: ListeningProgress, now: number): ImplicitSignal | null {
  if (progress.isFinished) return { verdict: 'finished', weight: 1 };
  if (progress.progress >= NEAR_COMPLETION) return { verdict: 'finished', weight: progress.progress };
  if (progress.progress < MIN_MEANINGFUL_PROGRESS) return null;

  const lastTouched = progress.lastPlayedAt ?? progress.updatedAt;
  const idleDays = (now - lastTouched) / MS_PER_DAY;
  if (idleDays < ABANDON_AFTER_DAYS) return null;

  const span = NEAR_COMPLETION - MIN_MEANINGFUL_PROGRESS;
  const howFar = (progress.progress - MIN_MEANINGFUL_PROGRESS) / span;
  const weight = Math.min(1, Math.max(0.05, 1 - howFar));
  return { verdict: 'abandoned', weight };
}

/** Query text recorded on a listening-derived row, so its provenance is legible in the table. */
export const IMPLICIT_QUERY_TEXT = '(listening history)';

export interface ApplyImplicitFeedbackResult {
  written: number;
  skipped: number;
}

/**
 * Turn every progress snapshot into at most one implicit feedback row.
 * Pure over its inputs apart from the `upsert` callback, so the caller owns
 * the transaction boundary and tests need no database.
 */
export function applyImplicitFeedback(
  progress: readonly ListeningProgress[],
  now: number,
  upsert: (input: { bookId: string; queryText: string; verdict: FeedbackVerdict; weight: number; createdAt: number }) => void
): ApplyImplicitFeedbackResult {
  let written = 0;
  let skipped = 0;
  for (const row of progress) {
    const signal = deriveImplicitSignal(row, now);
    if (!signal) {
      skipped += 1;
      continue;
    }
    upsert({
      bookId: row.bookId,
      queryText: IMPLICIT_QUERY_TEXT,
      verdict: signal.verdict,
      weight: signal.weight,
      // The signal is about when the listening happened, not when sync ran —
      // otherwise every re-sync would make old taste look brand new to the
      // recency decay in tasteProfile.ts.
      createdAt: row.lastPlayedAt ?? row.finishedAt ?? row.updatedAt,
    });
    written += 1;
  }
  return { written, skipped };
}
