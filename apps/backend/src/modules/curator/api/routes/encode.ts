/**
 * Encode routes: scan the ABS library directory, launch a background encode
 * operation, and inspect persisted job history. Pause/resume/cancel reuse the
 * generic /operations/:id/{pause,resume,cancel} routes — encode operations are
 * registered in the same OperationRegistry.
 *
 * Imports only core + sibling api. The live console (log/progress) is served over
 * the WebSocket layer (see api/ws.ts); these routes are plain request/response.
 */
import { Router } from 'express';

import { toAppError } from '../../core/errors.js';
import {
  assertEncoderEnabled,
  type EncoderRuntimeConfig,
} from '../../core/encoder/encodeEngine.js';
import { scanLibrary } from '../../core/encoder/scanner.js';
import { encodeOptionsSchema } from '../../core/encoder/encodeTypes.js';
import { asyncHandler } from '../http.js';
import type { ApiServices } from '../services.js';

function runtimeConfig(services: ApiServices): EncoderRuntimeConfig {
  const { config } = services;
  return {
    absLibraryId: config.absLibraryId,
  };
}

export function createEncodeRouter(services: ApiServices): Router {
  const RouterInstance = Router();
  const { config, db, absClient, absSocketClient, operations, actionLog, logger, encodeHub } = services;

  // Encoder readiness + defaults for the UI to render its options form.
  RouterInstance.get(
    '/encode/config',
    asyncHandler(async (_req, res) => {
      res.json({
        enabled: true,
        rescanAvailable: true,
      });
    })
  );

  // Fetch all libraries from ABS
  RouterInstance.get(
    '/encode/libraries',
    asyncHandler(async (_req, res) => {
      const libraries = await absClient.getLibraries();
      res.json(libraries);
    })
  );

  // Get cached candidates from database
  RouterInstance.get(
    '/encode/candidates',
    asyncHandler(async (req, res) => {
      const libraryId = (req.query.libraryId as string) || config.absLibraryId;
      if (!libraryId) {
         return res.status(400).json({ error: 'libraryId query parameter is required', code: 'BAD_REQUEST' });
      }
      const candidates = db.getEncodeCandidates(libraryId);
      res.json({ candidates, total: candidates.length });
    })
  );

  // Scan the library directory for encodable folders via ABS API and update cache.
  // Automatically excludes any items already in the queue.
  RouterInstance.get(
    '/encode/scan',
    asyncHandler(async (req, res) => {
      assertEncoderEnabled(runtimeConfig(services));
      const libraryId = (req.query.libraryId as string) || config.absLibraryId;
      if (!libraryId) {
         return res.status(400).json({ error: 'libraryId query parameter is required', code: 'BAD_REQUEST' });
      }
      // Build a set of IDs already in the queue so the scanner can exclude them.
      const currentQueue = db.listEncodeQueue();
      const queuedIds = new Set(currentQueue.map((q: any) => q.id));

      const candidates = await scanLibrary({
        absClient,
        libraryId,
        excludeIds: queuedIds,
      });
      // Cache the candidates
      db.replaceEncodeCandidates(libraryId, candidates);
      res.json({ candidates, total: candidates.length });
    })
  );

  // Queue management endpoints
  RouterInstance.get(
    '/encode/queue',
    asyncHandler(async (req, res) => {
      res.json(db.listEncodeQueue());
    })
  );

  RouterInstance.post(
    '/encode/queue',
    asyncHandler(async (req, res) => {
      assertEncoderEnabled(runtimeConfig(services));
      const { libraryId, candidates } = req.body;
      services.logger.info(`Received request to queue items`, { libraryId, candidatesCount: candidates?.length, candidates });

      if (!candidates || !Array.isArray(candidates)) {
        services.logger.error('Missing or invalid candidates array in request body');
        res.status(400).json({ error: 'candidates array required' });
        return;
      }

      // Fetch details for the candidates to enqueue them properly
      services.logger.info(`Scanning library ${libraryId || config.absLibraryId} to fetch candidate details...`);

      // Exclude already-queued items so we don't re-scan unnecessarily
      const currentQueue = db.listEncodeQueue();
      const queuedIds = new Set(currentQueue.map((q: any) => q.id));

      const scan = await scanLibrary({
        absClient,
        libraryId: libraryId || config.absLibraryId,
        excludeIds: queuedIds,
      });

      const wanted = new Set(candidates);
      const itemsToEnqueue = scan.filter(c => wanted.has(c.libraryItemId));

      services.logger.info(`Found ${itemsToEnqueue.length} matching candidates out of ${scan.length} scanned items`);

      const missingCandidates = candidates.filter(id => !itemsToEnqueue.some(c => c.libraryItemId === id));
      if (missingCandidates.length > 0) {
         services.logger.warn(`Removing stale candidates from database cache: ${JSON.stringify(missingCandidates)}`);
         for (const id of missingCandidates) {
           db.removeEncodeCandidate(id);
         }
      }

      try {
        if (itemsToEnqueue.length > 0) {
          await services.encodeWorker.enqueue(libraryId || config.absLibraryId, itemsToEnqueue);
          // Auto-remove enqueued items from candidate list too
          for (const item of itemsToEnqueue) {
            db.removeEncodeCandidate(item.libraryItemId);
          }
        }
        services.logger.info(`Successfully queued ${itemsToEnqueue.length} items`);
        res.status(202).json({ success: true, count: itemsToEnqueue.length });
      } catch (err) {
        services.logger.error('Failed to enqueue items', { err: String(err) });
        res.status(500).json({ error: 'Failed to enqueue items' });
      }
    })
  );

  RouterInstance.patch(
    '/encode/queue/:id',
    asyncHandler(async (req, res) => {
      const { sortOrder } = req.body;
      if (typeof sortOrder !== 'number') {
        res.status(400).json({ error: 'sortOrder required' });
        return;
      }
      services.encodeWorker.reorder(req.params.id as string, sortOrder);
      res.json({ success: true });
    })
  );

  /**
   * DELETE /encode/queue/:id
   *
   * Removes a queued item. For items with status=running, pass ?force=true
   * to detach AudioShelf's tracking while ABS finishes encoding in the
   * background. Without force, a running item returns 409 with a clear error.
   */
  RouterInstance.delete(
    '/encode/queue/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const force = req.query.force === 'true' || req.body?.force === true;

      const item = db.getEncodeQueueItem(id);
      if (!item) {
        // Already gone — treat as success (idempotent)
        res.json({ success: true, alreadyGone: true });
        return;
      }

      if (item.status === 'running' && !force) {
        res.status(409).json({
          error: 'Item is currently being encoded by ABS. Pass force=true to remove it from AudioShelf tracking (ABS will continue encoding in the background).',
          code: 'ITEM_RUNNING',
          hint: 'After removing, run a library rescan to pick up the result.',
        });
        return;
      }

      services.encodeWorker.remove(id, force);
      res.json({ success: true, forced: force && item.status === 'running' });
    })
  );

  /**
   * POST /encode/queue/:id/cancel
   *
   * Explicit cancel with a clear explanation. Always force-removes the item
   * from AudioShelf tracking and returns details about what happens next.
   * ABS cannot be interrupted — it will finish the encode and the .m4b will
   * appear on the next library rescan.
   */
  RouterInstance.post(
    '/encode/queue/:id/cancel',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const item = db.getEncodeQueueItem(id);

      if (!item) {
        res.status(404).json({ error: 'Queue item not found', code: 'NOT_FOUND' });
        return;
      }

      const wasRunning = item.status === 'running';
      services.encodeWorker.remove(id, true /* force */);

      res.json({
        success: true,
        wasRunning,
        message: wasRunning
          ? 'AudioShelf has stopped tracking this encode job. ABS will finish encoding in the background. Run a library rescan to pick up the result.'
          : 'Item removed from the queue.',
      });
    })
  );

  /**
   * GET /encode/status
   *
   * Live snapshot of the worker state plus ABS's active task list.
   * Useful for diagnosing stuck items.
   */
  RouterInstance.get(
    '/encode/status',
    asyncHandler(async (_req, res) => {
      const workerStatus = services.encodeWorker.getStatus();

      // Fetch ABS active tasks for cross-reference
      let absTasks: unknown[] = [];
      try {
        absTasks = await absClient.getActiveTasks();
      } catch {
        // Non-fatal — ABS may not support this endpoint
      }

      // If there's a currently running item, check ABS directly
      let currentItemEncoded: boolean | null = null;
      if (workerStatus.currentTaskId) {
        try {
          currentItemEncoded = await absClient.isItemEncoded(workerStatus.currentTaskId);
        } catch {
          currentItemEncoded = null;
        }
      }

      res.json({
        worker: workerStatus,
        queue: db.listEncodeQueue(),
        absActiveTasks: absTasks,
        currentItemAlreadyEncoded: currentItemEncoded,
      });
    })
  );

  RouterInstance.get(
    '/encode/history',
    asyncHandler(async (req, res) => {
      const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
      res.json(db.listEncodeHistory(Number.isFinite(limit) ? limit : 50));
    })
  );

  return RouterInstance;
}
