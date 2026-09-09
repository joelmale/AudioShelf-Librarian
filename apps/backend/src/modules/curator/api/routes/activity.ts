import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import {
  ActivityAggregator,
  type ActivityAggregatorDependencies,
} from '../../core/activityAggregator.js';
import { IngestStore } from '../../../librarian/ingestStore.js';
import { QBittorrentService } from '../../../librarian/services/qbittorrent.js';

export function createActivityRouter(
  services: ApiServices,
  extraDeps: Partial<ActivityAggregatorDependencies> = {},
): Router {
  const router = Router();

  const aggregatorDeps: ActivityAggregatorDependencies = {
    operations: extraDeps.operations ?? services.operations,
    db: extraDeps.db ?? services.db,
    ingestStore: extraDeps.ingestStore ?? new IngestStore(),
    qbtService: extraDeps.qbtService ?? new QBittorrentService(),
  };

  const aggregator = new ActivityAggregator(aggregatorDeps);

  /**
   * GET /activity/feed
   * Returns unified truth-grounded activity items grouped into:
   * - needsAttention
   * - inProgress
   * - completed
   * Along with per-provider connection status and live counts.
   */
  router.get(
    '/activity/feed',
    asyncHandler(async (_req: Request, res: Response) => {
      const feed = await aggregator.getFeed();
      res.json(feed);
    }),
  );

  /**
   * GET /activity/entities/:id
   * Resolves a specific entity across operations, encode queue/history,
   * ingest items, and torrent transfers.
   * If not found, returns an explicit 404 with honest unavailableReason.
   */
  router.get(
    '/activity/entities/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const result = await aggregator.resolveEntity(id);
      if (!result.found) {
        res.status(404).json({
          success: false,
          found: false,
          unavailableReason: result.unavailableReason,
        });
        return;
      }
      res.json({
        success: true,
        found: true,
        entity: result.entity,
        rawDetails: result.rawDetails,
      });
    }),
  );

  return router;
}
