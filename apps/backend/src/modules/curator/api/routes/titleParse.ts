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
  const { db, operations, actionLog, logger, config } = services;

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

  return router;
}
