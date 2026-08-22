/**
 * Embedding runner (librarian engine plan §3, "Embedding runner").
 *
 * Clones the `enricher.ts`/`tagger.ts` operational shape exactly: a `p-limit`
 * worker pool, an `OperationController` checkpoint per book (pause/cancel),
 * `dryRun` planning that makes no embed calls, per-book failure isolation
 * (A4), action-log events, a `sync_log` entry (kind 'embed'), and a `sample`
 * mode via the tagger's `computeSampleSize`/`selectSample` so a user can spot
 * check embedding quality before committing to a full-library run.
 *
 * The candidate pool is `db.getStaleEmbeddings()` — every active book (or
 * `bookIds`, if given) joined to its stored embedding identity. The database
 * cannot decide staleness itself (that needs a composed card hash, which
 * needs tags + entities assembled in TypeScript), so each candidate's card is
 * composed here and judged by {@link isEmbeddingStale}: never embedded,
 * embedded under a different model, and a changed card text are all the SAME
 * case, not three branches — a book is either stale or it is not. A second
 * run over an unchanged library must therefore make ZERO embed calls; every
 * candidate whose card still matches is counted into `unchanged` instead and
 * never enters the sampled/pooled work set.
 *
 * `processed`/`embedded` both count books this run actually wrote a fresh
 * vector for — kept as two fields because `processed` is the field every
 * other operation result (`TaggingResult`, `EnrichmentResult`) uses for
 * generic "how much work got done" UI, while `embedded` is the
 * embedding-domain-specific name a coverage view (`embedded` vs `unchanged`
 * vs total library) wants to read directly. The two are always equal.
 */
import pLimit from 'p-limit';

import type { CuratorDb, EmbeddingCandidate } from '../db.js';
import { AppError, OperationCancelledError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import { computeSampleSize, selectSample } from '../tagger.js';
import type { OperationError, ProgressCallback } from '../types.js';
import type { ActionLog } from '../actionLog.js';
import { composeBookCard } from './bookCard.js';
import type { EmbeddingCreator } from './embeddings.js';

export interface EmbeddingOptions {
  /** No embed calls — just report which books would be (re-)embedded and why. */
  dryRun?: boolean;
  /** Actually embed a representative sample (max(20, 5% of stale candidates)). */
  sample?: boolean;
  /** Override the sample size. */
  sampleSize?: number;
  /** Restrict to specific books (still filtered to stale ones). */
  bookIds?: string[];
  model: string;
  concurrency: number;
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
}

export interface EmbeddingPlanEntry {
  bookId: string;
  title: string;
  /** Why this book is being (re-)embedded. */
  reason: 'never-embedded' | 'model-changed' | 'card-changed';
}

export interface EmbeddingResult {
  processed: number;
  skipped: number;
  failed: number;
  errors: OperationError[];
  dryRun: boolean;
  sample?: boolean;
  cancelled?: boolean;
  plan?: EmbeddingPlanEntry[];
  /** Books this run actually wrote a fresh vector for. Always equal to `processed`. */
  embedded: number;
  /** Candidates whose card_hash still matched — no embed call made, this run or ever. */
  unchanged: number;
}

interface StaleEntry {
  candidate: EmbeddingCandidate;
  cardText: string;
  cardHash: string;
  reason: EmbeddingPlanEntry['reason'];
}

/**
 * True when a book must be (re-)embedded: never embedded, embedded under a
 * different model, or its card text changed since it was embedded. These are
 * deliberately collapsed into one predicate (never separate branches in the
 * caller) — the caller doesn't need to know WHY a book is stale to decide
 * whether to re-embed it, only WHETHER.
 */
export function isEmbeddingStale(candidate: EmbeddingCandidate, model: string, cardHash: string): boolean {
  return (
    candidate.storedCardHash === null || candidate.storedModel !== model || candidate.storedCardHash !== cardHash
  );
}

/** Which of the three staleness conditions applies, for the dry-run plan's `reason`. */
function staleReason(candidate: EmbeddingCandidate, model: string): EmbeddingPlanEntry['reason'] {
  if (candidate.storedCardHash === null) return 'never-embedded';
  if (candidate.storedModel !== model) return 'model-changed';
  return 'card-changed';
}

export async function embedBooks(
  db: CuratorDb,
  creator: EmbeddingCreator,
  options: EmbeddingOptions
): Promise<EmbeddingResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;
  const model = options.model;

  const candidates = db.getStaleEmbeddings(options.bookIds ? { bookIds: options.bookIds } : undefined);

  // Compose every candidate's card up front (pure, no I/O) and split into
  // unchanged (no embed call, ever) vs. stale (needs one). This is the whole
  // point of the card_hash design: a second run over an unchanged library
  // costs zero embed calls, not "cheap" calls.
  let unchanged = 0;
  const allStale: StaleEntry[] = [];
  for (const candidate of candidates) {
    const card = composeBookCard(candidate.book, db.getTagsForBook(candidate.book.id), db.getEntitiesForBook(candidate.book.id));
    if (isEmbeddingStale(candidate, model, card.hash)) {
      allStale.push({ candidate, cardText: card.text, cardHash: card.hash, reason: staleReason(candidate, model) });
    } else {
      unchanged += 1;
    }
  }

  const isSampling = Boolean(options.sample) || options.sampleSize !== undefined;

  // Sample mode: reduce the stale pool to a representative, deterministic
  // subset — everything downstream (pool, checkpoints, upsert) runs exactly
  // as it would for a real run over the full pool.
  let staleEntries = allStale;
  if (isSampling) {
    const sampledBooks = selectSample(
      allStale.map((e) => e.candidate.book),
      computeSampleSize(allStale.length, options.sampleSize)
    );
    const sampledIds = new Set(sampledBooks.map((b) => b.id));
    staleEntries = allStale.filter((e) => sampledIds.has(e.candidate.book.id));
  }

  const result: EmbeddingResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dryRun: Boolean(options.dryRun),
    embedded: 0,
    unchanged,
    ...(isSampling ? { sample: true } : {}),
  };

  const logId = db.startLog('embed', now());
  action?.record(
    'info',
    'embed_started',
    `Embedding run started (${staleEntries.length} stale, ${unchanged} unchanged)`,
    {
      operationId: opId,
      detail: {
        stale: staleEntries.length,
        unchanged,
        dryRun: result.dryRun,
        ...(isSampling ? { sample: true, sampled: staleEntries.length, staleTotal: allStale.length } : {}),
      },
    }
  );

  // ── Dry run: report the plan, make no embed calls. ───────────────────────
  if (options.dryRun) {
    const plan: EmbeddingPlanEntry[] = staleEntries.map(({ candidate, reason }) => ({
      bookId: candidate.book.id,
      title: candidate.book.title,
      reason,
    }));
    result.plan = plan;
    result.skipped = plan.length;
    db.finishLog(logId, 'success', { dryRun: true, planned: plan.length, unchanged }, now());
    action?.record('info', 'embed_dry_run', `Dry run: ${plan.length} books would be (re-)embedded`, {
      operationId: opId,
      detail: { planned: plan.length, unchanged },
    });
    options.controller?.markCompleted(result);
    return result;
  }

  if (staleEntries.length === 0) {
    db.finishLog(logId, 'success', { processed: 0, unchanged, note: 'no books due for embedding' }, now());
    options.controller?.markCompleted(result);
    return result;
  }

  const limit = pLimit(Math.max(1, options.concurrency));
  const total = staleEntries.length;
  let done = 0;
  let cancelled = false;

  const tasks = staleEntries.map((entry) =>
    limit(async () => {
      const { candidate, cardText, cardHash } = entry;
      const book = candidate.book;

      // Cooperative pause/cancel checkpoint before spending any embed calls.
      if (options.controller) {
        try {
          await options.controller.checkpoint();
        } catch (err) {
          if (err instanceof OperationCancelledError) {
            cancelled = true;
            result.skipped += 1;
            return;
          }
          throw err; // unexpected — don't swallow (D2)
        }
      }

      try {
        const vectors = await creator.create({ model, input: [cardText] });
        const vector = vectors[0];
        // Defensive against a misbehaving injected creator (the default Ollama
        // creator already guarantees this itself) — never assign a book a
        // vector that isn't unambiguously its own.
        if (vectors.length !== 1 || !vector) {
          throw new AppError(
            'LLM_INVALID_RESPONSE',
            `Embedding creator returned ${vectors.length} vector(s) for a single input`,
            { detail: { received: vectors.length } }
          );
        }
        db.upsertBookEmbedding({ bookId: book.id, model, cardHash, vector });

        result.processed += 1;
        result.embedded += 1;
        action?.record('info', 'book_embedded', `Embedded "${book.title}"`, {
          operationId: opId,
          detail: { bookId: book.id },
        });
      } catch (err) {
        // A4: record + continue; do NOT roll back books that already succeeded.
        const appErr = toAppError(err);
        result.failed += 1;
        result.errors.push({ id: book.id, code: appErr.code, message: appErr.message });
        action?.record('error', 'book_failed', `Failed to embed "${book.title}": ${appErr.message}`, {
          operationId: opId,
          detail: { bookId: book.id, code: appErr.code },
        });
        logger.warn('Failed to embed book', { bookId: book.id, code: appErr.code });
      } finally {
        done += 1;
        const progress = {
          phase: 'embed',
          current: done,
          total,
          message: book.title,
        };
        options.controller?.setProgress(progress);
        options.onProgress?.(progress);
      }
    })
  );

  await Promise.all(tasks);

  const status = result.processed === 0 && result.failed > 0 ? 'error' : 'success';
  db.finishLog(logId, status, { ...result, cancelled }, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'embed_cancelled', `Embedding cancelled after ${result.processed} embedded`, {
      operationId: opId,
      detail: {
        processed: result.processed,
        failed: result.failed,
        ...(isSampling ? { sample: true, sampled: staleEntries.length } : {}),
      },
    });
  } else {
    options.controller?.markCompleted(result);
    action?.record('info', 'embed_finished', `Embedding finished: ${result.processed} embedded, ${result.failed} failed`, {
      operationId: opId,
      detail: {
        processed: result.processed,
        failed: result.failed,
        ...(isSampling ? { sample: true, sampled: staleEntries.length } : {}),
      },
    });
  }

  return result;
}
