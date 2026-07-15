/**
 * Express application factory.
 *
 * Assembles request logging, JSON parsing, the API routers, the health probe,
 * static UI serving (production), and the central structured error handler.
 * Imports only from `src/core/` and sibling `src/api/` modules — never `src/mcp/`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express, type Request, type Response, type NextFunction } from 'express';

import { toAppError } from '../core/errors.js';
import { asyncHandler, errorHandler, notFoundHandler } from './http.js';
import { createAdminRouter } from './routes/admin.js';
import { createBooksRouter } from './routes/books.js';
import { createCollectionsRouter } from './routes/collections.js';
import { createEncodeRouter } from './routes/encode.js';
import { createOperationsRouter } from './routes/operations.js';
import { createRecommendationsRouter } from './routes/recommendations.js';
import { createSyncRouter } from './routes/sync.js';
import { createTagsRouter } from './routes/tags.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import type { ApiServices } from './services.js';

export const APP_VERSION = process.env.npm_package_version ?? '1.1.0';

function requestLogger(services: ApiServices) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      services.logger.debug('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  };
}

/** Resolve the built UI directory (dist/ui) relative to this module at runtime. */
function resolveUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/api at runtime
  return join(here, '..', 'ui');
}

export function createCuratorApiRouter(services: ApiServices): express.Router {
  const api = express.Router();
  api.use(createSyncRouter(services));
  api.use(createBooksRouter(services));
  api.use(createTagsRouter(services));
  api.use(createCollectionsRouter(services));
  api.use(createEncodeRouter(services));
  api.use(createOperationsRouter(services));
  api.use(createRecommendationsRouter(services));
  api.use(createAdminRouter(services));
  api.use(createWebhooksRouter(services));
  return api;
}

export function createApp(services: ApiServices): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(requestLogger(services));

  // Health probe (note: not under /api, per the plan).
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      let absConnected = false;
      try {
        const probe = await services.absClient.testConnection();
        absConnected = probe.ok;
      } catch {
        absConnected = false;
      }
      const lastSync = services.db.getLastLog('sync');
      const mem = process.memoryUsage();
      res.json({
        status: 'ok',
        version: APP_VERSION,
        absConnected,
        dbWritable: services.db.isWritable(),
        lastSyncAt: lastSync?.startedAt ?? null,
        lastSyncAgeMs: lastSync ? Date.now() - lastSync.startedAt : null,
        memoryRssMb: Math.round(mem.rss / 1024 / 1024),
        uptimeSec: Math.round(process.uptime()),
      });
    })
  );

  // API routers.
  const api = createCuratorApiRouter(services);
  app.use('/api', api);

  // Unknown API endpoints get a structured 404 (before the SPA catch-all).
  app.use('/api', notFoundHandler);

  // Static UI (production build). In dev the UI is served by Vite.
  const uiDir = resolveUiDir();
  if (existsSync(uiDir)) {
    app.use(express.static(uiDir));
    // SPA catch-all: anything not handled above returns index.html.
    app.get(/^\/(?!api\/|health).*/, (_req, res, next) => {
      const indexHtml = join(uiDir, 'index.html');
      if (existsSync(indexHtml)) res.sendFile(indexHtml);
      else next();
    });
  }

  app.use(errorHandler(services.logger));
  return app;
}

/** Re-export for callers that want to coerce unknown errors before responding. */
export { toAppError };
