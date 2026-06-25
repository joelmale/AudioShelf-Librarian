/**
 * Sync + operation-log routes. Thin clients over core/sync and core/db.
 */
import { Router } from 'express';

import { syncLibrary } from '../../core/sync.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

export function createSyncRouter(services: ApiServices): Router {
  const router = Router();
  const { db, absClient, logger } = services;

  router.post(
    '/sync',
    asyncHandler(async (_req, res) => {
      const result = await syncLibrary(absClient, db, { logger });
      res.json(result);
    })
  );

  router.get(
    '/log',
    asyncHandler(async (req, res) => {
      const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
      res.json(db.getRecentLogs(Number.isFinite(limit) ? limit : 50));
    })
  );

  return router;
}
