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
        pushAuthor?: boolean;
        pushSubtitle?: boolean;
        overwriteSubtitle?: boolean;
      }) ?? {};
      const dryRun = body.dryRun !== false;
      const includeLow = body.includeLowConfidence === true;
      const pushSeries = body.pushSeries !== false;
      const pushAuthor = body.pushAuthor !== false;
      const pushSubtitle = body.pushSubtitle !== false;
      const overwriteSubtitle = body.overwriteSubtitle === true;

      const books = db.getAllBooks(body.bookIds);
      const planned: Array<{
        bookId: string;
        from: string;
        to: string;
        series?: string;
        sequence?: number;
        author?: string;
        subtitle?: string;
        subtitleKept?: string;
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
        //
        // ONE exception, and it is the difference between a lost edit and a
        // resumable one: when the current title equals this parse's own
        // `normalizedTitle`, the title that "no longer exists" is the one THIS
        // push already replaced. The parse is not stale, it is applied — and
        // the fields it also carries (series, author, subtitle) may not be,
        // because a partial failure leaves exactly this state. Treating it as
        // stale made the push un-resumable: 18 books whose series ABS silently
        // dropped could not be repaired without discarding the parse that knew
        // their series, which the renamed title no longer contains.
        const alreadyApplied = book.title === raw.normalizedTitle;
        if (raw.original !== book.title && !alreadyApplied) {
          staleParses += 1;
          continue;
        }

        const titleChanges = raw.normalizedTitle && raw.normalizedTitle !== book.title;
        /**
         * The local series may ALREADY equal the parse — `updateTitleParse`
         * COALESCEs it into the mirror during the run phase. Comparing against
         * that value made `seriesChanges` false for every book whose series
         * this feature recovered, so the series was written locally and never
         * reached ABS: the one field the rename destroys was the one field not
         * restored. `titleMetaSource` records that provenance, so a series the
         * parse itself supplied still counts as a change to push.
         */
        const seriesFromParse = book.titleMetaSource?.series === 'title-parse';
        const seriesChanges =
          pushSeries && Boolean(raw.series) && (raw.series !== book.series || seriesFromParse);
        // The catalogued author is not merely missing on some shelves, it is
        // WRONG: 23 Xanth books carry author "Xanth Series", which is also why
        // the parse could not confirm an author and landed low-confidence. A
        // recovered author is worth writing back for exactly that case.
        const authorChanges = pushAuthor && Boolean(raw.author) && raw.author !== book.author;
        if (!titleChanges && !seriesChanges && !authorChanges) continue;

        const entry: (typeof planned)[number] = {
          bookId: book.id,
          from: book.title,
          to: raw.normalizedTitle,
          confidence: raw.confidence,
        };
        if (seriesChanges && raw.series) entry.series = raw.series;
        if (seriesChanges && raw.seriesSequence !== null) entry.sequence = raw.seriesSequence;
        if (authorChanges && raw.author) entry.author = raw.author;

        /**
         * Record `<Series> <NN>` in the subtitle as well.
         *
         * The series/sequence recovered here lives ONLY inside the title being
         * replaced. ABS stores series as a library-wide relation that a later
         * metadata match can re-point, so the subtitle is a second, per-book
         * copy that survives independently — and `Xanth 29` is exactly the
         * shape `splitSeriesSequence` reads, so the parse round-trips.
         *
         * The local mirror has no subtitle column, so the current value is
         * unknown until ABS is asked. Only planned books are fetched, which
         * bounds this to the size of the plan rather than the library. An
         * existing subtitle is NEVER overwritten without `overwriteSubtitle`
         * — it is reported as `subtitleKept` so the dry run shows what was
         * left alone.
         */
        if (pushSubtitle && raw.series && raw.seriesSequence !== null) {
          const wanted = `${raw.series} ${raw.seriesSequence}`;
          let current: string | null = null;
          try {
            const item = await absClient.getBook(book.id);
            current = item.media.metadata.subtitle ?? null;
          } catch (err) {
            // Not fatal: the rename is the point, the subtitle is insurance.
            // Treat an unreadable subtitle as "occupied" and leave it alone.
            logger.warn('Could not read current subtitle; leaving it unchanged', {
              bookId: book.id,
              code: toAppError(err).code,
            });
            current = '';
          }
          if (current && current.trim() && current.trim() !== wanted && !overwriteSubtitle) {
            entry.subtitleKept = current;
          } else if (current?.trim() !== wanted) {
            entry.subtitle = wanted;
          }
        }

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
            // Omitted when it already matches, so a repair run touches only
            // the fields that still need it.
            ...(change.to !== change.from ? { title: change.to } : {}),
            ...(change.series ? { series: change.series } : {}),
            ...(change.sequence !== undefined ? { sequence: String(change.sequence) } : {}),
            ...(change.author ? { author: change.author } : {}),
            ...(change.subtitle ? { subtitle: change.subtitle } : {}),
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
