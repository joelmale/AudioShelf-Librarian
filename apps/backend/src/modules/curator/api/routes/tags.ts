/**
 * Tagging routes. Long runs are launched as cancellable operations (see
 * routes/operations.ts for control + SSE). Imports only core + sibling api.
 */
import { Router } from 'express';
import { z } from 'zod';

import { deriveTags } from '../../core/derivedTags.js';
import { toAppError, ValidationError } from '../../core/errors.js';
import { reembedAffectedBooks } from '../../core/retrieval/reembedTrigger.js';
import { tagUntaggedBooks, type TaggingOptions } from '../../core/tagger.js';
import { regroundBooks } from '../../core/tagging/reground.js';
import { validateTagQuality } from '../../core/tagQuality.js';
import { tagCategorySchema } from '../../core/types.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

interface RunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  concurrency?: number;
}

/** Same shape as vocab.ts's promote/reject body — one term in one category. */
const termBodySchema = z.object({
  term: z.string().min(1),
  category: tagCategorySchema,
});

export function createTagsRouter(services: ApiServices): Router {
  const router = Router();
  const { db, llmClient, absClient, operations, actionLog, logger, config, embeddingCreator } = services;

  /** Launch a tagging operation in the background; return its id immediately. */
  function launch(
    body: RunBody,
    operationLabel: string,
    opts: { retagAll?: boolean } = {}
  ): { operationId: string; status: string } {
    const controller = operations.create('tag');
    const options: TaggingOptions = {
      concurrency: body.concurrency ?? config.taggingConcurrency,
      // Part of each run's recorded freshness identity — see
      // core/tagging/tagInputs.ts. Without it the run stores no hashes and
      // its books stay permanently `never-recorded`.
      taggingModel: config.taggingModel,
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
    if (config.autoPush) options.autoPush = true;

    logger.info('Tagging operation launched', { operationId: controller.id, label: operationLabel });
    // Fire-and-forget; the controller captures terminal state. Never leave the
    // rejection unhandled (D1).
    void tagUntaggedBooks(llmClient, db, options)
      .then((result) => {
        // Readiness plan item B: re-embed exactly the books this run wrote
        // tags for, scoped via bookIds rather than walking the whole
        // library. Chained onto the same background promise so it still
        // runs after a fire-and-forget launch; reembedAffectedBooks never
        // throws, so a failed/unreachable embedder cannot turn into a
        // tag_aborted error for a tagging run that actually succeeded.
        void reembedAffectedBooks(db, embeddingCreator, result.processedBookIds, {
          model: config.embeddingModel,
          concurrency: config.taggingConcurrency,
          actionLog,
          logger,
        });
      })
      .catch((err: unknown) => {
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

  /**
   * Recompose stored tags from the model's cached proposals — the free half
   * of tag refresh (core/tagging/reground.ts).
   *
   * This is the endpoint that closes the enrichment -> tagging loop: after an
   * enrich or re-derive moves `book_entities`, this applies the improvement
   * across the library without a single model call. `dryRun: true` reports
   * the full freshness survey — how many books are stale, why, how many can
   * be fixed free, and how many still need the model — and writes nothing.
   *
   * Deliberately its own route rather than a flag on `/tags/run`: the two
   * cost wildly different amounts, and a caller must never be able to reach
   * a paid library sweep by tweaking a parameter on a free one.
   */
  router.post(
    '/tags/reground',
    asyncHandler(async (req, res) => {
      const body = (req.body as { dryRun?: boolean; bookIds?: string[] }) ?? {};
      const controller = operations.create('tag');

      void regroundBooks(db, {
        taggingModel: config.taggingModel,
        controller,
        actionLog,
        logger,
        ...(body.dryRun ? { dryRun: true } : {}),
        ...(body.bookIds ? { bookIds: body.bookIds } : {}),
      })
        .then((result) => {
          // Same scoped re-embed the bulk tagger does, for the same reason:
          // these books' cards changed.
          //
          // Explicitly gated on the dry run rather than relying on the
          // embedder to no-op. A dry run reports `changedBookIds` (that is
          // its whole output) while writing no tags, so those cards did NOT
          // move — handing them to the embedder would walk the plan for
          // books nothing changed about. "It would skip them anyway" is not
          // a reason for a dry run to reach a live service at all.
          if (result.dryRun) return;
          void reembedAffectedBooks(db, embeddingCreator, result.changedBookIds, {
            model: config.embeddingModel,
            concurrency: config.taggingConcurrency,
            actionLog,
            logger,
          });
        })
        .catch((err: unknown) => {
          const appErr = toAppError(err);
          controller.markError({ code: appErr.code, message: appErr.message });
          actionLog.record('error', 'reground_aborted', `Re-ground aborted: ${appErr.message}`, {
            operationId: controller.id,
            detail: { code: appErr.code },
          });
        });

      res.status(202).json({ operationId: controller.id, status: controller.status });
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

  /**
   * Retract one term across the whole library. Rejecting a vocab term only
   * stops it being promoted — the rows stay on their books as `llm-open`, and
   * `excludeTags` ignores `trustedOnly` by design, so a wrong tag keeps
   * poisoning negative filters until it is actually deleted.
   */
  router.delete(
    '/tags/term',
    asyncHandler(async (req, res) => {
      const parsed = termBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid delete request', parsed.error.issues);
      const { term, category } = parsed.data;
      const removed = db.deleteTagTerm(term, category);
      logger.info('Tag term deleted', { term, category, removed });
      res.json({ term, category, removed });
    })
  );

  /**
   * Recompute derived tags (length, era, full-cast) for every active book.
   * `deriveTags` is a pure function of metadata the sync already holds, so
   * this costs no LLM tokens and is safe to re-run: it upserts only the
   * derived rows and leaves every LLM tag alone.
   */
  router.post(
    '/tags/derive',
    asyncHandler(async (req, res) => {
      const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
      const now = Date.now();
      const books = db.getAllBooks();

      let booksChanged = 0;
      let tagsWritten = 0;
      const byTag: Record<string, number> = {};

      for (const book of books) {
        const derived = deriveTags(book);
        if (derived.length === 0) continue;
        booksChanged += 1;
        tagsWritten += derived.length;
        for (const t of derived) byTag[`${t.category}:${t.tag}`] = (byTag[`${t.category}:${t.tag}`] ?? 0) + 1;
        if (!dryRun) db.upsertBookTags(book.id, derived, now);
      }

      logger.info(dryRun ? 'Derived-tag dry run' : 'Derived tags recomputed', { booksChanged, tagsWritten });
      res.json({ dryRun, booksScanned: books.length, booksChanged, tagsWritten, byTag });
    })
  );

  return router;
}
