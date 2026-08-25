/**
 * Wave 2 item B: re-embed exactly the books a tag-mutating operation just
 * touched (readiness plan `docs/phase-4-readiness.md`, "B. Re-embed after
 * tag mutation").
 *
 * `getStaleEmbeddings`/`embedBooks` (embedder.ts) already make staleness
 * queryable and skip any book whose composed card text didn't actually
 * change — this function's only job is to CALL that operation, scoped via
 * `bookIds`, from the operation/route layer right after a tag mutation
 * commits (the bulk tagger, `retag_book`, vocab promote/alias, enrichment).
 * It deliberately does not live inside `core/tagger.ts` or any other
 * tag-mutating core module — those stay free of embedding infrastructure;
 * only the callers that already assemble an `EmbeddingCreator` and model
 * config wire this in.
 *
 * Isolation is the whole point: a failed or partial re-embed must never
 * fail or roll back the tag write that already happened. Staleness is
 * queryable, so a book that fails here simply stays stale and the next
 * embed run (scoped or full-library) picks it up — this function's only
 * remaining job is to make sure "stays stale" is logged loudly, not
 * silently reported as success (invariant 5: a check that cannot succeed
 * must say so, never a confident number it didn't measure). It never
 * throws.
 */
import type { CuratorDb } from '../db.js';
import { toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { ActionLog } from '../actionLog.js';
import { embedBooks, type EmbeddingResult } from './embedder.js';
import type { EmbeddingCreator } from './embeddings.js';

export interface ReembedTriggerOptions {
  model: string;
  concurrency: number;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
}

export interface ReembedOutcome {
  /**
   * False when there was nothing to scope to (`bookIds` was empty) or the
   * embed operation itself threw before producing a result. Either way, no
   * claim is made about the affected books' freshness — a caller must not
   * read `attempted: false` as "nothing needed it".
   */
  attempted: boolean;
  /**
   * Present when `attempted` is true. `result.failed`/`result.processed`
   * report per-book outcomes honestly — a nonzero `failed` here means those
   * specific books are still stale even though the run was attempted.
   */
  result?: EmbeddingResult;
  /** Present when the embed operation itself threw (attempted: false). */
  error?: { code: string; message: string };
}

/**
 * Re-embed `bookIds` via `embedBooks`, scoped so an operation that touched
 * 40 books never walks the other 900+. Never throws: any failure (the whole
 * operation rejecting, not just an individual book) is caught, logged, and
 * reported back as a non-attempt rather than propagated to the caller.
 */
export async function reembedAffectedBooks(
  db: CuratorDb,
  creator: EmbeddingCreator,
  bookIds: string[],
  options: ReembedTriggerOptions
): Promise<ReembedOutcome> {
  const logger = options.logger ?? nullLogger;

  if (bookIds.length === 0) return { attempted: false };

  try {
    const result = await embedBooks(db, creator, {
      model: options.model,
      concurrency: options.concurrency,
      bookIds,
      actionLog: options.actionLog,
      logger,
      ...(options.now ? { now: options.now } : {}),
    });
    if (result.failed > 0) {
      logger.warn('Re-embed after tag mutation: some books failed and remain stale', {
        scoped: bookIds.length,
        failed: result.failed,
      });
    }
    return { attempted: true, result };
  } catch (err) {
    // The tag mutation that triggered this already committed. Never let a
    // re-embed failure propagate back to it (A4-style isolation) — log and
    // report honestly, and leave the affected books stale for the next run
    // (scoped or full) to pick up.
    const appErr = toAppError(err);
    logger.warn('Re-embed after tag mutation failed; affected books remain stale', {
      scoped: bookIds.length,
      code: appErr.code,
      message: appErr.message,
    });
    options.actionLog?.record('warn', 'reembed_after_mutation_failed', `Re-embed after tag mutation failed: ${appErr.message}`, {
      detail: { bookIds: bookIds.length, code: appErr.code },
    });
    return { attempted: false, error: { code: appErr.code, message: appErr.message } };
  }
}
