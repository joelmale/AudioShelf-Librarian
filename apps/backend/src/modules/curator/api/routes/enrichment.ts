/**
 * Enrichment routes: launch an operation that populates `external_metadata`
 * (Open Library + Audnexus + Google Books) and rebuilds `book_entities`. Long runs are
 * launched as cancellable operations (see routes/operations.ts for
 * pause/resume/cancel + SSE) — same launch shape as routes/tags.ts.
 *
 * Recommended flow: dry-run (plan the candidate pool and due providers, no
 * fetches) -> sample (a real run over max(20, 5%) of candidates, cheap
 * enough to QC provider hit rates and entity coverage against the live
 * providers via the operation's `qualityReport`) -> full run, once the
 * sample's report looks right.
 */
import { Router } from 'express';

import { enrichBooks, type EnrichmentOptions } from '../../core/enrichment/enricher.js';
import { audnexusProvider } from '../../core/enrichment/providers/audnexus.js';
import { createGoogleBooksProvider } from '../../core/enrichment/providers/googleBooks.js';
import { openLibraryProvider } from '../../core/enrichment/providers/openLibrary.js';
import { toAppError } from '../../core/errors.js';
import { reembedAffectedBooks } from '../../core/retrieval/reembedTrigger.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

interface RunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  /** Ignore cache TTLs — needed after the lookup query itself improves. */
  refresh?: boolean;
  concurrency?: number;
}

export function createEnrichmentRouter(services: ApiServices): Router {
  const router = Router();
  const { db, operations, actionLog, logger, config, embeddingCreator } = services;

  /**
   * Providers run per-book in sequence (librarian engine plan §2, build
   * order). Google Books is appended only when a key is configured — an
   * absent provider writes no `external_metadata` rows, so the day a key is
   * added every book becomes a fresh candidate with no `refresh` run needed.
   */
  const googleBooks = createGoogleBooksProvider(config.googleBooksApiKey);
  const PROVIDERS = [openLibraryProvider, audnexusProvider, ...(googleBooks ? [googleBooks] : [])];
  if (!googleBooks) {
    logger.info('Google Books enrichment provider disabled (GOOGLE_BOOKS_API_KEY not set)');
  }

  /** Launch an enrichment operation in the background; return its id immediately. */
  function launch(body: RunBody): { operationId: string; status: string } {
    const controller = operations.create('enrich');
    const options: EnrichmentOptions = {
      // No dedicated env var (AGENTS.md: don't add config surface without need) —
      // reuse the tagging concurrency knob, which governs the same class of
      // work (a p-limit pool of per-book network calls).
      concurrency: body.concurrency ?? config.taggingConcurrency,
      controller,
      actionLog,
      logger,
    };
    if (body.dryRun) options.dryRun = true;
    if (body.sample) options.sample = true;
    if (body.sampleSize !== undefined) options.sampleSize = body.sampleSize;
    if (body.bookIds) options.bookIds = body.bookIds;
    if (body.refresh) options.refresh = true;

    logger.info('Enrichment operation launched', { operationId: controller.id });
    // Fire-and-forget; the controller captures terminal state. Never leave the
    // rejection unhandled (D1).
    void enrichBooks(db, PROVIDERS, options)
      .then((result) => {
        // Readiness plan item B: enrichment rewrites grounded entities, which
        // are part of the composed card, so re-embed exactly the books this
        // run touched. reembedAffectedBooks never throws, so a failed or
        // unreachable embedder cannot turn into an enrich_aborted error for
        // an enrichment run that actually succeeded.
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
        actionLog.record('error', 'enrich_aborted', `Enrichment aborted: ${appErr.message}`, {
          operationId: controller.id,
          detail: { code: appErr.code },
        });
      });

    return { operationId: controller.id, status: controller.status };
  }

  router.post(
    '/enrichment/run',
    asyncHandler(async (req, res) => {
      res.status(202).json(launch((req.body as RunBody) ?? {}));
    })
  );

  return router;
}
