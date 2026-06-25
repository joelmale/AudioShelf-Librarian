/**
 * Operation control routes: list/inspect AI operations and pause/resume/cancel
 * them, plus a snapshot-based SSE stream. Streaming polls the controller's
 * snapshot (state, not deltas), so a reconnecting client never double-counts
 * progress.
 */
import { Router } from 'express';

import { NotFoundError } from '../../core/errors.js';
import type { LogLevel } from '../../core/config.js';
import { asyncHandler } from '../http.js';
import { openSse } from '../sse.js';
import type { ApiServices } from '../services.js';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function createOperationsRouter(services: ApiServices): Router {
  const router = Router();
  const { operations, actionLog } = services;

  router.get(
    '/operations',
    asyncHandler(async (_req, res) => {
      res.json(operations.list());
    })
  );

  router.get(
    '/operations/:id',
    asyncHandler(async (req, res) => {
      const op = operations.get(String(req.params.id));
      if (!op) throw new NotFoundError(`No operation ${req.params.id}`);
      res.json(op.snapshot());
    })
  );

  router.post(
    '/operations/:id/pause',
    asyncHandler(async (req, res) => {
      const op = operations.get(String(req.params.id));
      if (!op) throw new NotFoundError(`No operation ${req.params.id}`);
      const changed = op.pause();
      res.json({ changed, snapshot: op.snapshot() });
    })
  );

  router.post(
    '/operations/:id/resume',
    asyncHandler(async (req, res) => {
      const op = operations.get(String(req.params.id));
      if (!op) throw new NotFoundError(`No operation ${req.params.id}`);
      const changed = op.resume();
      res.json({ changed, snapshot: op.snapshot() });
    })
  );

  router.post(
    '/operations/:id/cancel',
    asyncHandler(async (req, res) => {
      const op = operations.get(String(req.params.id));
      if (!op) throw new NotFoundError(`No operation ${req.params.id}`);
      const changed = op.cancel();
      res.json({ changed, snapshot: op.snapshot() });
    })
  );

  // Snapshot-polling SSE — emits progress until the operation is terminal.
  router.get(
    '/operations/:id/stream',
    asyncHandler(async (req, res) => {
      const op = operations.get(String(req.params.id));
      if (!op) throw new NotFoundError(`No operation ${req.params.id}`);
      const channel = openSse(req, res);

      const tick = setInterval(() => {
        if (channel.isClosed) {
          clearInterval(tick);
          return;
        }
        const snap = op.snapshot();
        channel.progress(snap);
        if (op.isTerminal()) {
          clearInterval(tick);
          channel.complete(snap);
        }
      }, 500);

      // Emit one immediately so reconnecting clients get current state at once.
      channel.progress(op.snapshot());
      if (op.isTerminal()) {
        clearInterval(tick);
        channel.complete(op.snapshot());
      }
    })
  );

  // Action log (verbosity-filterable troubleshooting buffer).
  router.get(
    '/logs/actions',
    asyncHandler(async (req, res) => {
      const level = LOG_LEVELS.find((l) => l === req.query.level);
      const query: Parameters<typeof actionLog.query>[0] = {};
      if (level) query.level = level;
      if (typeof req.query.operationId === 'string') query.operationId = req.query.operationId;
      if (req.query.since !== undefined) {
        const since = Number.parseInt(String(req.query.since), 10);
        if (Number.isFinite(since)) query.since = since;
      }
      const limit = Number.parseInt(String(req.query.limit ?? '200'), 10);
      query.limit = Number.isFinite(limit) ? limit : 200;
      res.json(actionLog.query(query));
    })
  );

  // Runtime verbosity control for the action-log buffer.
  router.put(
    '/settings/log-level',
    asyncHandler(async (req, res) => {
      const level = LOG_LEVELS.find((l) => l === (req.body as { level?: unknown })?.level);
      if (!level) {
        res.status(400).json({ error: `level must be one of ${LOG_LEVELS.join(', ')}`, code: 'VALIDATION' });
        return;
      }
      actionLog.setBufferThreshold(level);
      res.json({ level });
    })
  );

  return router;
}
