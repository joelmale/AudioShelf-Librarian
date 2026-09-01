/**
 * Route-level test for the re-check campaign endpoint.
 *
 * A whole-library re-check does not fit in one run — Google Books' free tier
 * is 1000 queries/day against ~2-6 queries per book — so the panel has to be
 * able to ASK what campaign is in progress and how much of it is left. That
 * makes the endpoint's existence load-bearing, and a route that is defined but
 * never mounted falls through to the SPA handler and returns index.html with a
 * 200 (see the docblock on readiness.test.ts). So this mounts the whole
 * curator API router, exactly as that test does.
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

describe('GET /api/enrichment/refresh-campaign', () => {
  it('reports no campaign when none has ever been started', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, 'c1');

    const res = await fetch(`${await listen(db, 'stub-model')}/api/enrichment/refresh-campaign`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ campaign: null });
  });

  it('reports the campaign epoch and how many books it still has to check', async () => {
    const db = new CuratorDb(':memory:');
    databases.push(db);
    addBook(db, 'c1');
    addBook(db, 'c2');

    // A first run of the campaign got through c1 only.
    const campaignStart = Date.now() - 60_000;
    const logId = db.startLog('enrich', campaignStart);
    db.finishLog(logId, 'success', { processed: 1, refreshBefore: campaignStart }, campaignStart + 10);
    db.upsertExternalMetadata({
      bookId: 'c1',
      provider: 'openlibrary',
      payload: {},
      fetchedAt: campaignStart + 5,
      status: 'ok',
    });

    const res = await fetch(`${await listen(db, 'stub-model')}/api/enrichment/refresh-campaign`);
    const body = (await res.json()) as { campaign: { refreshBefore: number; startedAt: number; remaining: number } };

    expect(body.campaign.refreshBefore).toBe(campaignStart);
    expect(body.campaign.startedAt).toBe(campaignStart);
    // Both books: c2 was never reached at all, and c1 was only re-checked
    // against Open Library — Audnexus and Wikidata still owe it an answer, and
    // `remaining` is the union across providers, which is what a run picks up.
    // (Google Books and Hardcover are absent from this router: no key is
    // configured, so they contribute no candidates rather than empty rows.)
    expect(body.campaign.remaining).toBe(2);
  });
});
