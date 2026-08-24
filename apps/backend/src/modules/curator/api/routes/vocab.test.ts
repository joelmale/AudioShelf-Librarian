/**
 * Route-level tests for the vocabulary promotion queue. DB-level behavior
 * (refreshProposedVocabCounts, retagLlmOpenTags, isVocabTerm, ...) is already
 * exercised in core/db.vocab.test.ts — these tests cover only what lives in
 * the route itself: request validation, 404/400 mapping, and response shape.
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createVocabRouter } from './vocab.js';

function addBook(db: CuratorDb, input: Pick<Book, 'id' | 'title'>): void {
  db.upsertBook({
    ...input,
    author: null,
    series: null,
    seriesSequence: null,
    durationSeconds: null,
    publishedYear: null,
    genres: [],
    description: null,
    coverPath: null,
    absAddedAt: null,
    lastSyncedAt: Date.now(),
  });
}

function buildApp(db: CuratorDb) {
  const app = express();
  app.use(express.json());
  app.use('/api', createVocabRouter({ db } as ApiServices));
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never));
  return app;
}

const databases: CuratorDb[] = [];
const servers: import('node:http').Server[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function makeDb(): CuratorDb {
  const db = new CuratorDb(':memory:');
  databases.push(db);
  return db;
}

describe('GET /vocab/proposed', () => {
  it('refreshes counts then returns proposed terms with sample titles', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/proposed`);
    const body = (await res.json()) as Array<{ term: string; sampleBooks: string[] }>;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ term: 'noblebright', category: 'mood', status: 'proposed', bookCount: 1 });
    expect(body[0]?.sampleBooks).toEqual(['Alpha']);
  });
});

describe('POST /vocab/promote', () => {
  it('404s when the term is not a proposed vocab term', async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'ghost', category: 'mood' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('400s on an invalid body', async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'x', category: 'not-a-category' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION');
  });

  it('promotes a proposed term and retags matching llm-open rows to vocab', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.6, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'noblebright', category: 'mood' }),
    });
    const body = (await res.json()) as { term: string; category: string; status: string; retagged: number };

    expect(res.status).toBe(200);
    expect(body).toEqual({ term: 'noblebright', category: 'mood', status: 'promoted', retagged: 2 });
    expect(db.isVocabTerm('noblebright', 'mood')).toBe(true);
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });
  });
});

describe('POST /vocab/reject', () => {
  it('rejects a proposed term and returns the updated row', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'zany', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'zany', category: 'mood' }),
    });
    const body = (await res.json()) as { term: string; category: string; status: string; bookCount: number };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ term: 'zany', category: 'mood', status: 'rejected', bookCount: 1 });
    expect(db.getVocabTerms(['rejected']).some((t) => t.term === 'zany')).toBe(true);
  });
});

describe('POST /vocab/alias', () => {
  it('400s when the canonical term is not a seed/promoted vocab term', async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'spooky', canonical: 'not-a-real-term', category: 'mood' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION');
  });

  it('aliases into a seed term, retags matching rows, and resolves the alias out of the proposed queue', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'spooky', category: 'mood', confidence: 0.5, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const canonical = db.getVocabTerms(['seed']).find((t) => t.category === 'mood')!.term;
    const app = buildApp(db);

    const res = await fetch(`${await listen(app)}/api/vocab/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'spooky', canonical, category: 'mood' }),
    });
    const body = (await res.json()) as { alias: string; canonical: string; category: string; retagged: number };

    expect(res.status).toBe(200);
    expect(body).toEqual({ alias: 'spooky', canonical, category: 'mood', retagged: 1 });
    expect(db.getTagAlias('spooky', 'mood')).toEqual({ alias: 'spooky', canonical, category: 'mood' });
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: canonical, source: 'vocab' });
    expect(db.getVocabTerms(['proposed']).some((t) => t.term === 'spooky')).toBe(false);
    expect(
      db.getVocabTerms(['rejected']).some((t) => t.term === 'spooky' && t.category === 'mood')
    ).toBe(true);
  });
});

/** Start an ephemeral server for one test (closed in afterEach) and return its base origin. */
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}
