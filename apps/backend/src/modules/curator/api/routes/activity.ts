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

  // The aggregator is built on first request, not here. Constructing it opens a
  // second SQLite connection to the ambient DB_PATH/DATA_DIR, so doing it at
  // router-construction time made merely *mounting* the API router depend on
  // that directory already existing — which it does not in CI or in route tests
  // that supply their own database.
  let aggregator: ActivityAggregator | undefined;
  const getAggregator = (): ActivityAggregator => {
    if (!aggregator) {
      const aggregatorDeps: ActivityAggregatorDependencies = {
        operations: extraDeps.operations ?? services.operations,
        db: extraDeps.db ?? services.db,
        ingestStore: extraDeps.ingestStore ?? new IngestStore(),
        qbtService: extraDeps.qbtService ?? new QBittorrentService(),
      };
      aggregator = new ActivityAggregator(aggregatorDeps);
    }
    return aggregator;
  };

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
      const feed = await getAggregator().getFeed();
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
      const result = await getAggregator().resolveEntity(id);
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
