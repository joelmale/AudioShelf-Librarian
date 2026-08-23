/**
 * Tagging routes. Long runs are launched as cancellable operations (see
 * routes/operations.ts for control + SSE). Imports only core + sibling api.
 */
import { Router } from 'express';

import { toAppError } from '../../core/errors.js';
import { tagUntaggedBooks, type TaggingOptions } from '../../core/tagger.js';
import { validateTagQuality } from '../../core/tagQuality.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

interface RunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  concurrency?: number;
}

export function createTagsRouter(services: ApiServices): Router {
  const router = Router();
  const { db, llmClient, absClient, operations, actionLog, logger, config } = services;

  /** Launch a tagging operation in the background; return its id immediately. */
  function launch(
    body: RunBody,
    operationLabel: string,
    opts: { retagAll?: boolean } = {}
  ): { operationId: string; status: string } {
    const controller = operations.create('tag');
    const options: TaggingOptions = {
      concurrency: body.concurrency ?? config.taggingConcurrency,
      controller,
      actionLog,
      absClient,
      logger,
    };
    if (body.dryRun) options.dryRun = true;
    if (body.sample) options.sample = true;
    if (body.sampleSize !== undefined) options.sampleSize = body.sampleSize;
    if (body.bookIds) options.bookIds = body.bookIds;
    if (opts.retagAll) options.retagAll = true;

    logger.info('Tagging operation launched', { operationId: controller.id, label: operationLabel });
    // Fire-and-forget; the controller captures terminal state. Never leave the
    // rejection unhandled (D1).
    void tagUntaggedBooks(llmClient, db, options).catch((err: unknown) => {
      const appErr = toAppError(err);
      controller.markError({ code: appErr.code, message: appErr.message });
      actionLog.record('error', 'tag_aborted', `Tagging aborted: ${appErr.message}`, {
        operationId: controller.id,
        detail: { code: appErr.code },
      });
    });

    return { operationId: controller.id, status: controller.status };
  }

  router.get(
    '/tags/stats',
    asyncHandler(async (_req, res) => {
      const total = db.countBooks();
      const tagged = db.countTaggedBooks();
      res.json({
        totalBooks: total,
        taggedBooks: tagged,
        untaggedBooks: total - tagged,
        vocabularySize: db.getTagVocabulary().length,
        avgTagTokens: db.getAverageTagTokenUsage(),
      });
    })
  );

  router.get(
    '/tags/vocabulary',
    asyncHandler(async (_req, res) => {
      res.json(db.getTagVocabulary());
    })
  );

  router.get(
    '/tags/quality',
    asyncHandler(async (_req, res) => {
      res.json(validateTagQuality(db));
    })
  );

  router.post(
    '/tags/run',
    asyncHandler(async (req, res) => {
      res.status(202).json(launch((req.body as RunBody) ?? {}, 'run'));
    })
  );

  router.post(
    '/tags/retag',
    asyncHandler(async (req, res) => {
      const body = (req.body as RunBody) ?? {};
      const bookIds = body.bookIds ?? [];
      if (bookIds.length === 0) {
        res.status(400).json({ error: 'retag requires a non-empty bookIds array', code: 'VALIDATION' });
        return;
      }
      // retagAll: true selects these bookIds regardless of their current tag
      // state and clears each one's tags inside the worker, immediately
      // before it's re-tagged — not up front for the whole batch. See
      // tagger.ts for why that bounds a mid-run failure to one book.
      res.status(202).json(launch({ ...body, bookIds }, 'retag', { retagAll: true }));
    })
  );

  router.post(
    '/tags/retag-all',
    asyncHandler(async (req, res) => {
      const body = (req.body as RunBody) ?? {};
      // No bookIds: candidates are every active book. Same per-book clear
      // semantics as `/tags/retag` — see tagger.ts's `retagAll` option.
      res.status(202).json(launch({ ...body, bookIds: undefined }, 'retag-all', { retagAll: true }));
    })
  );

  router.get(
    '/books/:id/tags',
    asyncHandler(async (req, res) => {
      res.json(db.getTagsForBook(String(req.params.id)));
    })
  );

  router.delete(
    '/books/:id/tags',
    asyncHandler(async (req, res) => {
      const removed = db.deleteBookTags(String(req.params.id));
      res.json({ removed });
    })
  );

  return router;
}
