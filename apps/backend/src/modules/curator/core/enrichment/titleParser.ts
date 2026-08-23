/**
 * Title-parse runner (librarian engine plan).
 *
 * Clones `enricher.ts`'s operational shape exactly: `p-limit` worker pool,
 * `OperationController` checkpoint per book (pause/cancel), `dryRun` planning,
 * `sample`/`sampleSize` via `tagger.ts`'s `computeSampleSize`/`selectSample`,
 * per-book failure isolation (A4), action-log events, and a `sync_log` entry
 * (kind 'title-parse').
 *
 * Per book: `parseTitle(book.title, book.author)`, then **fill NULLs only**:
 *   - `books.author` — only if currently null AND `parse.author` non-null
 *   - `books.published_year` — only if currently null AND `parse.year` non-null
 *   - `parse.ordinal` is NEVER written to `seriesSequence`. The same leading-
 *     number syntax means a personal list position under one naming
 *     convention (`52 - Frankenstein`) and a story index under another
 *     (`2_ Apt Pupil`); a wrong series number silently reorders a real
 *     series, which is worse than not recording it at all. It is preserved
 *     inside the stored `title_parse` JSON only.
 *   - `normalized_title` + the full `title_parse` are always written, and
 *     `title_meta_source` records provenance for whichever fields were
 *     actually filled — see `db.updateTitleParse`'s docblock, which enforces
 *     the "fill nulls only" rule at the SQL layer too.
 *
 * The dry run is the feature this module exists to deliver: because titles
 * are sometimes the only surviving copy of a book's author or year, the user
 * must be able to see exactly what a real run would (and would not) touch
 * before anything is written. Every dry run returns a `review` table — one
 * entry per candidate book, capped at `REVIEW_CAP` rows for payload size,
 * with `reviewTotal` carrying the true count — plus totals for how many
 * books would gain an author, a year, or landed at low confidence.
 */
import pLimit from 'p-limit';

import { OperationCancelledError, toAppError } from '../errors.js';
import { nullLogger, type Logger } from '../logger.js';
import type { OperationController } from '../operations.js';
import { computeSampleSize, selectSample } from '../tagger.js';
import type { Book, ProgressCallback } from '../types.js';
import type { CuratorDb } from '../db.js';
import type { ActionLog } from '../actionLog.js';
import { parseTitle, type TitleParse } from './titleParse.js';
import type { TitleParseResult, TitleParseReviewEntry } from './types.js';

export interface TitleParseOptions {
  /** No writes — just parse every candidate and report the review table. */
  dryRun?: boolean;
  /** Actually parse a representative sample (max(20, 5% of candidates)). */
  sample?: boolean;
  /** Override the sample size. */
  sampleSize?: number;
  /** Restrict to specific books (still filtered to those needing a parse). */
  bookIds?: string[];
  concurrency: number;
  controller?: OperationController;
  onProgress?: ProgressCallback;
  actionLog?: ActionLog;
  logger?: Logger;
  now?: () => number;
}

/** Dry-run review rows are capped for payload size; `reviewTotal` carries the true count. */
export const REVIEW_CAP = 50;

/** Field names a parse would fill on `books`, given the book's CURRENT values. Never `seriesSequence`. */
function wouldFillFields(book: Book, parse: TitleParse): string[] {
  const fields: string[] = [];
  if (!book.author && parse.author) fields.push('author');
  if (!book.publishedYear && parse.year) fields.push('publishedYear');
  return fields;
}

function buildReviewEntry(book: Book, parse: TitleParse, wouldFill: string[]): TitleParseReviewEntry {
  return {
    bookId: book.id,
    originalTitle: book.title,
    normalizedTitle: parse.normalizedTitle,
    existingAuthor: book.author,
    existingYear: book.publishedYear,
    parsedAuthor: parse.author,
    parsedYear: parse.year,
    ordinal: parse.ordinal,
    confidence: parse.confidence,
    wouldFill,
  };
}

export async function parseBookTitles(db: CuratorDb, options: TitleParseOptions): Promise<TitleParseResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const opId = options.controller?.id;
  const action = options.actionLog;

  const allCandidates = db.getBooksNeedingTitleParse(options.bookIds ? { bookIds: options.bookIds } : undefined);
  const isSampling = Boolean(options.sample) || options.sampleSize !== undefined;
  const candidates = isSampling
    ? selectSample(allCandidates, computeSampleSize(allCandidates.length, options.sampleSize))
    : allCandidates;

  const result: TitleParseResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dryRun: Boolean(options.dryRun),
    filledAuthorCount: 0,
    filledYearCount: 0,
    lowConfidenceCount: 0,
    ...(isSampling ? { sample: true } : {}),
  };

  const logId = db.startLog('title-parse', now());
  action?.record('info', 'title_parse_started', `Title-parse run started (${candidates.length} candidates)`, {
    operationId: opId,
    detail: {
      candidates: candidates.length,
      dryRun: result.dryRun,
      ...(isSampling ? { sample: true, sampled: candidates.length, candidatesTotal: allCandidates.length } : {}),
    },
  });

  // ── Dry run: parse everything, write nothing, return the review table. ──
  if (options.dryRun) {
    const review: TitleParseReviewEntry[] = [];
    for (const book of candidates) {
      const parse = parseTitle(book.title, book.author);
      const wouldFill = wouldFillFields(book, parse);
      if (wouldFill.includes('author')) result.filledAuthorCount += 1;
      if (wouldFill.includes('publishedYear')) result.filledYearCount += 1;
      if (parse.confidence === 'low') result.lowConfidenceCount += 1;
      if (review.length < REVIEW_CAP) review.push(buildReviewEntry(book, parse, wouldFill));
    }
    result.review = review;
    result.reviewTotal = candidates.length;
    result.skipped = candidates.length;
    db.finishLog(logId, 'success', { dryRun: true, planned: candidates.length }, now());
    action?.record('info', 'title_parse_dry_run', `Dry run: ${candidates.length} books would be parsed`, {
      operationId: opId,
      detail: {
        planned: candidates.length,
        filledAuthorCount: result.filledAuthorCount,
        filledYearCount: result.filledYearCount,
        lowConfidenceCount: result.lowConfidenceCount,
      },
    });
    options.controller?.markCompleted(result);
    return result;
  }

  if (candidates.length === 0) {
    db.finishLog(logId, 'success', { processed: 0, note: 'no books need title parsing' }, now());
    options.controller?.markCompleted(result);
    return result;
  }

  const limit = pLimit(Math.max(1, options.concurrency));
  let done = 0;
  let cancelled = false;

  const tasks = candidates.map((book) =>
    limit(async () => {
      // Cooperative pause/cancel checkpoint before doing any work.
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
        const parse = parseTitle(book.title, book.author);
        const wouldFill = wouldFillFields(book, parse);
        const harvested: { author?: string | null; publishedYear?: number | null } = {};
        if (wouldFill.includes('author')) harvested.author = parse.author;
        if (wouldFill.includes('publishedYear')) harvested.publishedYear = parse.year;

        // Synchronous write → serializes through the single writer (C1).
        // NEVER writes parse.ordinal to seriesSequence — see this module's
        // docblock and db.updateTitleParse's.
        db.updateTitleParse(book.id, parse, harvested);

        if (wouldFill.includes('author')) result.filledAuthorCount += 1;
        if (wouldFill.includes('publishedYear')) result.filledYearCount += 1;
        if (parse.confidence === 'low') result.lowConfidenceCount += 1;

        result.processed += 1;
        action?.record('info', 'book_title_parsed', `Parsed title for "${book.title}"`, {
          operationId: opId,
          detail: { bookId: book.id, normalizedTitle: parse.normalizedTitle, wouldFill, confidence: parse.confidence },
        });
      } catch (err) {
        // A4: record + continue; do NOT roll back books that already succeeded.
        const appErr = toAppError(err);
        result.failed += 1;
        result.errors.push({ id: book.id, code: appErr.code, message: appErr.message });
        action?.record('error', 'book_failed', `Failed to parse title for "${book.title}": ${appErr.message}`, {
          operationId: opId,
          detail: { bookId: book.id, code: appErr.code },
        });
        logger.warn('Failed to parse book title', { bookId: book.id, code: appErr.code });
      } finally {
        done += 1;
        const progress = {
          phase: 'title-parse',
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
  db.finishLog(logId, status, { ...result, cancelled }, now());

  if (cancelled) {
    result.cancelled = true;
    options.controller?.markCancelled(result);
    action?.record('warn', 'title_parse_cancelled', `Title-parse cancelled after ${result.processed} parsed`, {
      operationId: opId,
      detail: {
        processed: result.processed,
        failed: result.failed,
        ...(isSampling ? { sample: true, sampled: candidates.length } : {}),
      },
    });
  } else {
    options.controller?.markCompleted(result);
    action?.record('info', 'title_parse_finished', `Title-parse finished: ${result.processed} parsed, ${result.failed} failed`, {
      operationId: opId,
      detail: {
        processed: result.processed,
        failed: result.failed,
        ...(isSampling ? { sample: true, sampled: candidates.length } : {}),
      },
    });
  }

  return result;
}
