/**
 * Route-level test for the library-readiness signal (plan §10.D).
 *
 * The computation is covered in `core/readiness.test.ts`; what only this file
 * can prove is that the endpoint the Desk header requests actually EXISTS at
 * `/api/readiness`. That is not a hypothetical failure here — five callers in
 * the frontend's `api.ts` once requested paths no route matched, fell through
 * to the SPA static handler, and got `index.html` back with a 200 (see
 * `apps/frontend/src/features/curator/api.routes.test.ts`). The Desk health
 * panel sat broken for a while looking merely unhealthy.
 *
 * So this mounts the WHOLE curator API router, not just the readiness one —
 * a router that is never registered in `server.ts` would pass a test that
 * mounts it directly.
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createCuratorApiRouter } from '../server.js';

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function addBook(db: CuratorDb, id: string): void {
  db.upsertBook({
    id,
    title: `Title ${id}`,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: 1_000,
  } as Book);
}

const nullLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

async function listen(db: CuratorDb, embeddingModel: string | undefined): Promise<string> {
  const services = {
    db,
    config: { embeddingModel, taggingConcurrency: 2 },
    logger: nullLogger,
    actionLog: { record: () => {} },
    operations: { list: () => [] },
    absClient: {},
    absSocketClient: {},
    llmClient: {},
    embeddingCreator: {},
    encodeHub: { subscribe: () => () => {} },
    encodeWorker: {},
  } as unknown as ApiServices;

  const app = express();
  app.use(express.json());
  app.use('/api', createCuratorApiRouter(services));
  app.use(errorHandler(nullLogger as never));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

describe('GET /api/readiness', () => {
  it('is registered on the curator API router and returns the readiness summary', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    // Two books, one enriched and resolved, neither entity-grounded: 50%
    // external metadata and 0% entities, worked out by hand.
    addBook(db, 'r1');
    addBook(db, 'r2');
    db.upsertExternalMetadata({ bookId: 'r1', provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
    db.upsertExternalMetadata({
      bookId: 'r2',
      provider: 'openlibrary',
      payload: null,
      fetchedAt: 1,
      status: 'not-found',
    });

    const res = await fetch(`${await listen(db, 'stub-model')}/api/readiness`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      totalBooks: number;
      metrics: Array<{ key: string; label: string; pct: number | null; attempted?: number }>;
      disclosure: string | null;
    };
    expect(body.totalBooks).toBe(2);
    expect(body.metrics.find((m) => m.key === 'enriched')?.pct).toBe(50);
    expect(body.metrics.find((m) => m.key === 'enriched')).toMatchObject({
      label: 'External metadata found',
      attempted: 2,
    });
    // Enrichment ran for both books and found no entities — a genuine zero.
    expect(body.metrics.find((m) => m.key === 'entities')?.pct).toBe(0);
    expect(body.disclosure).toContain('state this in your answer');
  });

  it('serves the read-only grounding residual grouped for source-pilot sizing', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, 'r1');
    addBook(db, 'r2');
    db.upsertExternalMetadata({ bookId: 'r1', provider: 'openlibrary', payload: {}, fetchedAt: 1, status: 'ok' });
    db.upsertExternalMetadata({ bookId: 'r2', provider: 'openlibrary', payload: null, fetchedAt: 1, status: 'not-found' });

    const res = await fetch(`${await listen(db, 'stub-model')}/api/readiness/grounding-residual`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      totalBooks: 2,
      groundedBooks: 0,
      ungroundedBooks: 2,
      withResolvedMetadata: 1,
      providers: [{ provider: 'openlibrary', attempted: 2, resolved: 1, notFound: 1, errors: 0 }],
    });
  });

  it('serves Unknown, not 0%, for embedding coverage when no model is configured', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, 'r1');

    // EMBEDDING_MODEL set but blank: `config.ts` uses `??`, which does not
    // default on an empty string, so this value really can reach the route.
    const res = await fetch(`${await listen(db, '')}/api/readiness`);
    const body = (await res.json()) as {
      unmeasured: string[];
      metrics: Array<{ key: string; pct: number | null; status: string }>;
    };
    const embedded = body.metrics.find((m) => m.key === 'embedded');
    expect(embedded?.pct).toBeNull();
    expect(embedded?.pct).not.toBe(0);
    expect(embedded?.status).toBe('Unknown');
    expect(body.unmeasured).toContain('embedded');
  });
});
