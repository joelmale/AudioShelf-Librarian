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
  encodeCandidates,
  type EncoderRuntimeConfig,
  type EncodeEngineDeps,
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

  // Scan the library directory for encodable folders via ABS API
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
      res.json({ candidates, total: candidates.length });
    })
  );

  // Launch a background encode operation; return its ids immediately (202).
  RouterInstance.post(
    '/encode/run',
    asyncHandler(async (req, res) => {
      assertEncoderEnabled(runtimeConfig(services));
      const options = encodeOptionsSchema.parse((req.body as unknown) ?? {});
      const controller = operations.create('encode');
      const opId = controller.id;

      const jobId = db.insertEncodeJob({
        operationId: opId,
        candidateCount: options.candidates?.length ?? 0,
        startedAt: Date.now(),
      });

      const deps: EncodeEngineDeps = {
        config: runtimeConfig(services),
        absClient,
        absSocketClient,
        controller,
        actionLog,
        logger,
        onLine: (line) => encodeHub.emitLog(opId, line),
        onProgress: (p) => {
          encodeHub.emitProgress(opId, p);
          if (p.phase === 'encode') db.updateEncodeJob(jobId, { doneCount: p.current });
        },
      };

      logger.info('Encode operation launched', { operationId: opId, jobId });
      void encodeCandidates(options, deps)
        .then((result) => {
          const status = result.cancelled ? 'cancelled' : result.failed > 0 && result.encoded === 0 ? 'error' : 'completed';
          db.updateEncodeJob(jobId, {
            status,
            doneCount: result.encoded + result.failed,
            finishedAt: Date.now(),
            detail: result,
          });
          encodeHub.emitStatus(opId, status, result);
        })
        .catch((err: unknown) => {
          const appErr = toAppError(err);
          controller.markError({ code: appErr.code, message: appErr.message });
          db.updateEncodeJob(jobId, {
            status: 'error',
            finishedAt: Date.now(),
            detail: { error: appErr.toPayload() },
          });
          encodeHub.emitStatus(opId, 'error', appErr.toPayload());
          actionLog.record('error', 'encode_aborted', `Encode aborted: ${appErr.message}`, {
            operationId: opId,
            detail: { code: appErr.code },
          });
        });

      res.status(202).json({ operationId: opId, jobId, status: controller.status });
    })
  );

  RouterInstance.get(
    '/encode/jobs',
    asyncHandler(async (req, res) => {
      const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
      res.json(db.listEncodeJobs(Number.isFinite(limit) ? limit : 50));
    })
  );

  RouterInstance.get(
    '/encode/jobs/:id',
    asyncHandler(async (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      const job = Number.isFinite(id) ? db.getEncodeJob(id) : undefined;
      if (!job) {
        res.status(404).json({ error: `No encode job ${req.params.id}`, code: 'NOT_FOUND' });
        return;
      }
      res.json(job);
    })
  );

  return RouterInstance;
}
