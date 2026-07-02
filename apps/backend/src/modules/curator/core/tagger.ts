/**
 * Per-book Claude tagging engine.
 *
 * Runs untagged books through a `p-limit` worker pool at TAGGING_CONCURRENCY;
 * each Claude call is rate-limited inside LlmClient. SQLite writes are
 * synchronous, so they serialize through the single writer (adversarial C1).
 *
 * Adversarial set (MADP-FULL — the project's highest-value QA target, where the
 * worker-pool × partial-failure × idempotency interactions hide bugs):
 *  - A4: one book failing does NOT abort the run; good books persist, the failure
 *    is recorded and logged, the run continues.
 *  - C1: concurrent writes serialize (better-sqlite3 is synchronous).
 *  - C2: re-tagging replaces tags rather than appending (db.replaceBookTags).
 *  - D1–D3: every task is awaited; errors become typed OperationErrors; no empty
 *    catch swallows anything silently (everything is recorded + logged).
 *
 * Extra capabilities (user requirements): plan-only `dryRun`; `sample` mode that
 * really tags max(20, 5% of candidates) to preview quality/cost; and pause/cancel
 * via an OperationController checkpoint between books.
 */
import pLimit from 'p-limit';

import type { ABSClient } from './absClient.js';
import type { ActionLog } from './actionLog.js';
import type { LlmClient } from './llmClient.js';
import type { CuratorDb } from './db.js';
import { OperationCancelledError, toAppError } from './errors.js';
import { nullLogger, type Logger } from './logger.js';
import type { OperationController } from './operations.js';
import {
  addUsage,
  emptyUsage,
  type Book,
  type ProgressCallback,
  type TaggingPlanEntry,
  type TaggingResult,
} from './types.js';

export interface TaggingOptions {
  /** No API calls — just report the books that would be tagged. */
  dryRun?: boolean;
  /** Actually tag a representative sample (max(20, 5% of candidates)). */
  sample?: boolean;
  /** Override the sample size. */
  sampleSize?: number;
  /** Restrict to specific books (still filtered to untagged ones). */
  bookIds?: string[];
  concurrency: number;
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  absClient: ABSClient;
  logger?: Logger;
  now?: () => number;
}

const MIN_SAMPLE = 20;
const SAMPLE_FRACTION = 0.05;

export function computeSampleSize(candidateCount: number, override?: number): number {
  if (override !== undefined) return Math.min(Math.max(override, 0), candidateCount);
  return Math.min(candidateCount, Math.max(MIN_SAMPLE, Math.ceil(candidateCount * SAMPLE_FRACTION)));
}

/** Evenly-spread (deterministic) sample across the candidate list. */
export function selectSample(books: Book[], size: number): Book[] {
  if (size >= books.length) return books;
  const step = books.length / size;
  const out: Book[] = [];
  for (let i = 0; i < size; i += 1) {
    const book = books[Math.floor(i * step)];
    if (book) out.push(book);
  }
  return out;
}

export async function tagUntaggedBooks(
  llmClient: LlmClient,
  db: CuratorDb,
  options: TaggingOptions
): Promise<TaggingResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const allCandidates = db.getUntaggedBooks(options.bookIds);
  const candidates =
    options.sample || options.sampleSize !== undefined
      ? selectSample(allCandidates, computeSampleSize(allCandidates.length, options.sampleSize))
      : allCandidates;

  const result: TaggingResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    tokensUsed: emptyUsage(),
    dryRun: Boolean(options.dryRun),
  };

  const logId = db.startLog('tag', now());
  action?.record('info', 'tag_started', `Tagging run started (${candidates.length} candidates)`, {
    operationId: opId,
    detail: { candidates: candidates.length, dryRun: result.dryRun, sample: Boolean(options.sample) },
  });

  // ── Dry run: report the plan, make no API calls. ─────────────────────────
  if (options.dryRun) {
    const plan: TaggingPlanEntry[] = candidates.map((b) => ({ bookId: b.id, title: b.title }));
    result.plan = plan;
    result.skipped = plan.length;
    db.finishLog(logId, 'success', { dryRun: true, planned: plan.length }, now());
    action?.record('info', 'tag_dry_run', `Dry run: ${plan.length} books would be tagged`, {
      operationId: opId,
      detail: { planned: plan.length },
    });
    options.controller?.markCompleted(result);
    return result;
  }

  if (candidates.length === 0) {
    db.finishLog(logId, 'success', { processed: 0, note: 'no untagged books' }, now());
    options.controller?.markCompleted(result);
    return result;
  }

  const limit = pLimit(Math.max(1, options.concurrency));
  let done = 0;
  let cancelled = false;

  const tasks = candidates.map((book) =>
    limit(async () => {
      // Cooperative pause/cancel checkpoint before spending an API call.
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
        const tagged = await llmClient.tagBook(book);
        // Synchronous write → serializes through the single writer (C1); replaces
        // existing tags rather than appending (C2).
        db.replaceBookTags(book.id, tagged.tags, now());
        
        // Push tags to ABS server for permanence
        await options.absClient.updateBookTags(book.id, tagged.tags.map((t) => t.tag));

        result.processed += 1;
        result.tokensUsed = addUsage(result.tokensUsed, tagged.usage);
        action?.record('info', 'book_tagged', `Tagged "${book.title}"`, {
          operationId: opId,
          detail: { bookId: book.id, tags: tagged.tags.length, usage: tagged.usage },
        });
      } catch (err) {
        // A4: record + continue; do NOT roll back the books that succeeded.
        const appErr = toAppError(err);
        result.failed += 1;
        result.errors.push({ id: book.id, code: appErr.code, message: appErr.message });
        action?.record('error', 'book_failed', `Failed "${book.title}": ${appErr.message}`, {
          operationId: opId,
          detail: { bookId: book.id, code: appErr.code },
        });
        logger.warn('Failed to tag book', { bookId: book.id, code: appErr.code });
      } finally {
        done += 1;
        const progress = {
          phase: 'tag',
          current: done,
          total: candidates.length,
          message: book.title,
        };
        options.controller?.setProgress(progress);
        options.onProgress?.(progress);
      }
    })
  );

  await Promise.all(tasks);

  const status = result.processed === 0 && result.failed > 0 ? 'error' : 'success';
  const detail = { ...result, cancelled };
  db.finishLog(logId, status, detail, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'tag_cancelled', `Tagging cancelled after ${result.processed} tagged`, {
      operationId: opId,
      detail: { processed: result.processed, failed: result.failed },
    });
  } else {
    options.controller?.markCompleted(result);
    action?.record('info', 'tag_finished', `Tagging finished: ${result.processed} tagged, ${result.failed} failed`, {
      operationId: opId,
      detail: { processed: result.processed, failed: result.failed },
    });
  }

  return result;
}
