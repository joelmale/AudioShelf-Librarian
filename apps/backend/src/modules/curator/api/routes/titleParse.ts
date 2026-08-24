/**
 * Title-parse route: launch an operation that recovers author/year from
 * filename-derived titles and annotates every book with its parse (see
 * `core/enrichment/titleParser.ts`). Same launch shape as
 * `routes/enrichment.ts` — a long run is launched as a cancellable
 * operation, and the endpoint returns its id immediately (202).
 *
 * Recommended flow: dry-run (parse every candidate, write nothing, review the
 * `review` table for what would be filled) -> sample or full run once the
 * review looks right.
 */
import { Router } from 'express';

import { parseBookTitles, type TitleParseOptions } from '../../core/enrichment/titleParser.js';
import { toAppError } from '../../core/errors.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

interface RunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  /** Re-parse books already carrying a parse — needed after a parser change. */
  reparse?: boolean;
  concurrency?: number;
}

export function createTitleParseRouter(services: ApiServices): Router {
  const router = Router();
  const { db, absClient, operations, actionLog, logger, config } = services;

  /** Launch a title-parse operation in the background; return its id immediately. */
  function launch(body: RunBody): { operationId: string; status: string } {
    const controller = operations.create('title-parse');
    const options: TitleParseOptions = {
      // No dedicated env var (AGENTS.md: don't add config surface without
      // need) — reuse the tagging concurrency knob, same class of work as
      // enrichment (a p-limit pool of per-book units of work).
      concurrency: body.concurrency ?? config.taggingConcurrency,
      controller,
      actionLog,
      logger,
    };
    if (body.dryRun) options.dryRun = true;
    if (body.sample) options.sample = true;
    if (body.sampleSize !== undefined) options.sampleSize = body.sampleSize;
    if (body.bookIds) options.bookIds = body.bookIds;
    if (body.reparse) options.reparse = true;

    logger.info('Title-parse operation launched', { operationId: controller.id });
    // Fire-and-forget; the controller captures terminal state. Never leave the
    // rejection unhandled (D1).
    void parseBookTitles(db, options).catch((err: unknown) => {
      const appErr = toAppError(err);
      controller.markError({ code: appErr.code, message: appErr.message });
      actionLog.record('error', 'title_parse_aborted', `Title-parse aborted: ${appErr.message}`, {
        operationId: controller.id,
        detail: { code: appErr.code },
      });
    });

    return { operationId: controller.id, status: controller.status };
  }

  router.post(
    '/title-parse/run',
    asyncHandler(async (req, res) => {
      res.status(202).json(launch((req.body as RunBody) ?? {}));
    })
  );

  /**
   * Push normalized titles (and recovered series/sequence) back to ABS.
   *
   * This is the only way to make a corrected title stick: ABS owns
   * `books.title` and every sync overwrites the local copy, so a local-only
   * normalisation is erased on the next pull. It is also one-way — ABS has no
   * undo — which is why the defaults are deliberately timid:
   *
   *  - `dryRun` unless explicitly false, so the plan is reviewable first;
   *  - `high` confidence only unless `includeLowConfidence`, because a low
   *    parse is precisely the one a human should look at;
   *  - `limit` so a first pass can touch ten books and be eyeballed in ABS
   *    before committing to all of them.
   *
   * The previous title is recoverable from each book's stored `title_parse`
   * JSON (`original`), which this never modifies.
   */
  router.post(
    '/title-parse/push',
    asyncHandler(async (req, res) => {
      const body = (req.body as {
        dryRun?: boolean;
        limit?: number;
        bookIds?: string[];
        includeLowConfidence?: boolean;
        pushSeries?: boolean;
      }) ?? {};
      const dryRun = body.dryRun !== false;
      const includeLow = body.includeLowConfidence === true;
      const pushSeries = body.pushSeries !== false;

      const books = db.getAllBooks(body.bookIds);
      const planned: Array<{
        bookId: string;
        from: string;
        to: string;
        series?: string;
        sequence?: number;
        confidence: string;
      }> = [];

      let staleParses = 0;

      for (const book of books) {
        // mapBook already decodes the stored title_parse JSON onto the book.
        const raw = book.titleParse;
        if (!raw) continue;
        if (!includeLow && raw.confidence !== 'high') continue;

        // The parse describes a title that no longer exists — someone renamed
        // the book in ABS (or an ABS metadata match did) after we parsed it.
        // Pushing here would silently REVERT that edit to a normalisation of
        // the old title. Observed on a real library:
        //   parsed  "Pern 08 - Moreta, Dragonlady of Pern"
        //   now     "Dragonlady of Pern"
        //   push    would set it back to "Moreta, Dragonlady of Pern"
        // Re-run title parsing to refresh the parse, then push.
        if (raw.original !== book.title) {
          staleParses += 1;
          continue;
        }

        const titleChanges = raw.normalizedTitle && raw.normalizedTitle !== book.title;
        const seriesChanges = pushSeries && Boolean(raw.series) && raw.series !== book.series;
        if (!titleChanges && !seriesChanges) continue;

        const entry: (typeof planned)[number] = {
          bookId: book.id,
          from: book.title,
          to: raw.normalizedTitle,
          confidence: raw.confidence,
        };
        if (seriesChanges && raw.series) entry.series = raw.series;
        if (seriesChanges && raw.seriesSequence !== null) entry.sequence = raw.seriesSequence;
        planned.push(entry);

        if (planned.length >= (body.limit ?? Number.POSITIVE_INFINITY)) break;
      }

      if (dryRun) {
        logger.info('Title push dry run', { planned: planned.length, staleParses });
        res.json({ dryRun: true, planned: planned.length, skippedStaleParse: staleParses, changes: planned });
        return;
      }

      let pushed = 0;
      const errors: Array<{ bookId: string; message: string }> = [];
      for (const change of planned) {
        try {
          await absClient.updateBookMetadata(change.bookId, {
            title: change.to,
            ...(change.series ? { series: change.series } : {}),
            ...(change.sequence !== undefined ? { sequence: String(change.sequence) } : {}),
          });
          pushed += 1;
          actionLog.record('info', 'title_pushed', `Renamed "${change.from}" to "${change.to}" in ABS`, {
            detail: { bookId: change.bookId, series: change.series, sequence: change.sequence },
          });
        } catch (err) {
          // A4: record and continue; a mid-run failure must not roll back the
          // books already renamed.
          const appErr = toAppError(err);
          errors.push({ bookId: change.bookId, message: appErr.message });
        }
      }

      logger.info('Title push finished', { pushed, failed: errors.length, staleParses });
      res.json({
        dryRun: false,
        planned: planned.length,
        pushed,
        failed: errors.length,
        skippedStaleParse: staleParses,
        errors,
      });
    })
  );

  return router;
}
