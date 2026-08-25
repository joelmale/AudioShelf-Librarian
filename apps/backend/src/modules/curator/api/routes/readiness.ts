/**
 * Library-readiness route (plan §10.D, readiness item D).
 *
 * `GET /readiness` — % enriched, % with grounded entities, % tagged at the
 * current tag schema version, % embedded, plus TWO coverage sentences when
 * coverage is materially low: `disclosure` (model-facing, what the librarian
 * must state) and `caveat` (human-facing, what the Desk header renders). The
 * Desk header reads `caveat`; `disclosure` reaches the librarian through the
 * `query_library` MCP tool and must never be rendered.
 *
 * Cheap by construction — a handful of indexed `COUNT(DISTINCT)` queries over
 * the local mirror, no ABS call and no filesystem walk. That is deliberate:
 * `/librarian/health/library` had to drop to a 5-minute refresh because it
 * fetches every ABS item, and a header signal cannot afford that.
 */
import { Router } from 'express';

import { computeLibraryReadiness } from '../../core/readiness.js';
import { TAG_SCHEMA_VERSION } from '../../core/types.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

export function createReadinessRouter(services: ApiServices): Router {
  const router = Router();
  const { db, config } = services;

  router.get(
    '/readiness',
    asyncHandler(async (_req, res) => {
      res.json(
        computeLibraryReadiness(db, {
          schemaVersion: TAG_SCHEMA_VERSION,
          // `config.embeddingModel` is an empty string when EMBEDDING_MODEL is
          // set but blank (`??` only defaults on undefined). Passing it through
          // as null is what makes the embedded metric report Unknown rather
          // than a confident 0% for a system with no embedder — invariant 5.
          embeddingModel: config.embeddingModel || null,
        })
      );
    })
  );

  return router;
}
