/**
 * Route-level tests for the Phase 5 feedback surfaces.
 *
 * Mounts the WHOLE curator API router, not just this one — a router that is
 * never registered in `server.ts` would pass a test that mounted it directly,
 * which is exactly how five frontend callers once fell through to the SPA
 * static handler and got `index.html` back with a 200. Same reasoning as
 * `readiness.test.ts`.
 */
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { Book, ListeningProgress, ListeningSession } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createCuratorApiRouter } from '../server.js';

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  vi.restoreAllMocks();
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

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

async function listen(
  db: CuratorDb,
  absClient: { getListeningProgress?: unknown; getListeningSessions?: unknown } = {}
): Promise<string> {
  const services = {
    db,
    config: { embeddingModel: 'test-model', taggingConcurrency: 2 },
    logger: nullLogger,
    actionLog: { record: () => {} },
    operations: { list: () => [] },
    absClient,
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

describe('POST /api/feedback', () => {
  it('is registered and records an explicit verdict', async () => {
    const db = makeDb();
    addBook(db, 'b1');
    const base = await listen(db);

    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', queryText: 'beach mystery', verdict: 'accepted' }),
    });

    expect(res.status).toBe(201);
    const rows = db.getRecFeedback();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookId: 'b1', verdict: 'accepted', source: 'explicit', weight: 1 });
  });

  it('refuses a listening-derived verdict over HTTP', async () => {
    // `finished`/`abandoned` are behavioural facts. If a client could post
    // them, the taste profile could be shaped by something other than what
    // the user actually listened to.
    const db = makeDb();
    addBook(db, 'b1');
    const base = await listen(db);

    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', queryText: 'q', verdict: 'finished' }),
    });

    expect(res.status).toBe(400);
    expect(db.getRecFeedback()).toHaveLength(0);
  });

  it('rejects an unknown book id rather than storing an orphan verdict', async () => {
    const db = makeDb();
    const base = await listen(db);

    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId: 'nope', queryText: 'q', verdict: 'accepted' }),
    });

    expect(res.status).toBe(400);
    expect(db.getRecFeedback()).toHaveLength(0);
  });

  it('requires exactly one of bookId or externalKey', async () => {
    const db = makeDb();
    addBook(db, 'b1');
    const base = await listen(db);

    for (const body of [
      { queryText: 'q', verdict: 'accepted' },
      { bookId: 'b1', externalKey: 'a|b', queryText: 'q', verdict: 'accepted' },
    ]) {
      const res = await fetch(`${base}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /api/feedback/impressions', () => {
  it('records the whole slate with its rank positions', async () => {
    const db = makeDb();
    addBook(db, 'b1');
    addBook(db, 'b2');
    const base = await listen(db);

    const res = await fetch(`${base}/api/feedback/impressions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slateId: 'slate-1',
        queryText: 'beach mystery',
        items: [
          { bookId: 'b1', rank: 0, score: 0.9 },
          { bookId: 'b2', rank: 1, score: 0.4 },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const stored = db.getRecImpressions('slate-1');
    expect(stored.map((row) => [row.bookId, row.rank])).toEqual([['b1', 0], ['b2', 1]]);
  });
});

describe('POST /api/listening/sync', () => {
  it('pulls progress and sessions from ABS and reports what it stored', async () => {
    const db = makeDb();
    addBook(db, 'b1');
    const progress: ListeningProgress[] = [{
      bookId: 'b1',
      progress: 1,
      isFinished: true,
      startedAt: null,
      finishedAt: 1_000,
      timeListening: 3600,
      lastPlayedAt: 1_000,
      updatedAt: 1_000,
    }];
    const sessions: ListeningSession[] = [
      { id: 's1', bookId: 'b1', startedAt: 1_000, duration: 600, playbackSpeed: 2, device: 'phone' },
    ];
    const base = await listen(db, {
      getListeningProgress: vi.fn(async () => progress),
      getListeningSessions: vi.fn(async () => sessions),
    });

    const res = await fetch(`${base}/api/listening/sync`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ progressStored: 1, sessionsInserted: 1, feedbackWritten: 1 });
    expect(db.getListeningSessions()).toHaveLength(1);
  });
});

describe('GET /api/taste', () => {
  it('reports an honest cold start rather than empty modes', async () => {
    // "available: false" must not be presented as "you like nothing" (§10.J).
    const db = makeDb();
    const base = await listen(db);

    const res = await fetch(`${base}/api/taste`);

    expect(res.status).toBe(200);
    const body = await res.json() as { available: boolean; modes: unknown[]; reason?: string };
    expect(body.available).toBe(false);
    expect(body.modes).toEqual([]);
    expect(body.reason).toBeTruthy();
  });
});
