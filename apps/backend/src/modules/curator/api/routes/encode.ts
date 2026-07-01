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

  // Scan the library directory for encodable folders via ABS API and update cache
  RouterInstance.get(
    '/encode/scan',
    asyncHandler(async (req, res) => {
      assertEncoderEnabled(runtimeConfig(services));
      const libraryId = (req.query.libraryId as string) || config.absLibraryId;
      if (!libraryId) {
         return res.status(400).json({ error: 'libraryId query parameter is required', code: 'BAD_REQUEST' });
      }
      const candidates = await scanLibrary({
        absClient,
        libraryId
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
      if (!candidates || !Array.isArray(candidates)) {
        res.status(400).json({ error: 'candidates array required' });
        return;
      }
      
      // Fetch details for the candidates to enqueue them properly
      const scan = await scanLibrary({
        absClient,
        libraryId: libraryId || config.absLibraryId
      });
      
      const wanted = new Set(candidates);
      const itemsToEnqueue = scan.filter(c => wanted.has(c.libraryItemId));
      
      await services.encodeWorker.enqueue(libraryId || config.absLibraryId, itemsToEnqueue);
      res.status(202).json({ success: true, count: itemsToEnqueue.length });
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

  RouterInstance.delete(
    '/encode/queue/:id',
    asyncHandler(async (req, res) => {
      services.encodeWorker.remove(req.params.id as string);
      res.json({ success: true });
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
