/**
 * Embedding routes: launch an operation that (re-)embeds each active book's
 * composed card via the configured Ollama model, driven by `card_hash`
 * staleness so an unchanged library costs zero embed calls on re-run. Long
 * runs are launched as cancellable operations (see routes/operations.ts for
 * pause/resume/cancel + SSE) — same launch shape as routes/enrichment.ts.
 *
 * Recommended flow: dry-run (plan the stale-book pool and why each book is
 * stale, no embed calls) -> sample (a real run over min(40, 5%) of the stale
 * pool, cheap enough to spot-check embedding quality) -> full run.
 */
import { Router } from 'express';

import { z } from 'zod';

import {
  embedBooks,
  reportEmbeddingCoverage,
  type EmbeddingOptions,
} from '../../core/retrieval/embedder.js';
import { AppError } from '../../core/errors.js';
import { createOllamaEmbeddingCreator } from '../../core/retrieval/embeddings.js';
import { toAppError } from '../../core/errors.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

const coverageQuerySchema = z.object({
  state: z.enum(['fresh', 'never-embedded', 'model-changed', 'card-changed']).optional(),
  limit: z.coerce.number().int().min(0).max(5000).optional(),
});

interface RunBody {
  dryRun?: boolean;
  sample?: boolean;
  sampleSize?: number;
  bookIds?: string[];
  concurrency?: number;
}

export function createEmbeddingsRouter(services: ApiServices): Router {
  const router = Router();
  const { db, operations, actionLog, logger, config } = services;

  /** Launch an embedding operation in the background; return its id immediately. */
  function launch(body: RunBody): { operationId: string; status: string } {
    const controller = operations.create('embed');
    const creator = createOllamaEmbeddingCreator({ ollamaUrl: config.ollamaUrl, logger });
    const options: EmbeddingOptions = {
      model: config.embeddingModel,
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

    logger.info('Embedding operation launched', { operationId: controller.id });
    // Fire-and-forget; the controller captures terminal state. Never leave the
    // rejection unhandled (D1).
    void embedBooks(db, creator, options).catch((err: unknown) => {
      const appErr = toAppError(err);
      controller.markError({ code: appErr.code, message: appErr.message });
      actionLog.record('error', 'embed_aborted', `Embedding aborted: ${appErr.message}`, {
        operationId: controller.id,
        detail: { code: appErr.code },
      });
    });

    return { operationId: controller.id, status: controller.status };
  }

  /**
   * Read-only coverage diagnostic. `GET /api/embeddings/coverage`.
   *
   * `POST /embeddings/run {dryRun:true}` already reports the same staleness
   * reasons, but it launches an operation and returns an id to poll, which is
   * more ceremony than "which books have no vector?" deserves. This makes no
   * embed calls, writes nothing, and answers in one request.
   */
  router.get(
    '/embeddings/coverage',
    asyncHandler(async (req, res) => {
      const parsed = coverageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION', 'Invalid state or limit');
      }
      const { state, limit } = parsed.data;
      res.json(
        reportEmbeddingCoverage(db, config.embeddingModel, {
          ...(state !== undefined ? { state } : {}),
          ...(limit !== undefined ? { limit } : {}),
        })
      );
    })
  );

  router.post(
    '/embeddings/run',
    asyncHandler(async (req, res) => {
      res.status(202).json(launch((req.body as RunBody) ?? {}));
    })
  );

  return router;
}
