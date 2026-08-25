/**
 * Route-level tests for the vocabulary promotion queue. DB-level behavior
 * (refreshProposedVocabCounts, retagLlmOpenTags, isVocabTerm, ...) is already
 * exercised in core/db.vocab.test.ts — these tests cover only what lives in
 * the route itself: request validation, 404/400 mapping, and response shape.
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { CuratorDb } from '../../core/db.js';
import { createStubEmbeddingCreator } from '../../core/retrieval/fixtures/stubEmbedder.js';
import type { EmbeddingCreator } from '../../core/retrieval/embeddings.js';
import type { Book } from '../../core/types.js';
import { errorHandler } from '../http.js';
import type { ApiServices } from '../services.js';
import { createVocabRouter } from './vocab.js';

const EMBEDDING_MODEL = 'stub-model';

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

/** `embeddingCreator` defaults to the deterministic offline stub — pass one
 *  explicitly to exercise the re-embed failure path (readiness plan item B). */
function buildApp(db: CuratorDb, embeddingCreator: EmbeddingCreator = createStubEmbeddingCreator()) {
  const app = express();
  app.use(express.json());
  const services = {
    db,
    config: { embeddingModel: EMBEDDING_MODEL, taggingConcurrency: 2 },
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    actionLog: { record: () => {} },
    embeddingCreator,
  } as unknown as ApiServices;
  app.use('/api', createVocabRouter(services));
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
    const body = (await res.json()) as {
      term: string;
      category: string;
      status: string;
      retagged: number;
      reembed: { attempted: boolean };
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ term: 'noblebright', category: 'mood', status: 'promoted', retagged: 2 });
    expect(body.reembed.attempted).toBe(true);
    expect(db.isVocabTerm('noblebright', 'mood')).toBe(true);
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });
  });

  // Readiness plan item B, exit criterion: "a test that promotes a vocab
  // term and asserts the affected books' embeddings are stale, then no
  // longer stale after the follow-up run."
  it('the affected books go from never-embedded (stale) to embedded (not stale) as a direct effect of the promote request', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    addBook(db, { id: 'b2', title: 'Beta' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.replaceBookTags('b2', [{ tag: 'noblebright', category: 'mood', confidence: 0.6, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);
    const app = buildApp(db);

    // Before: neither book has ever been embedded, so both are stale by
    // getStaleEmbeddings's own definition (storedCardHash === null).
    const before = db.getStaleEmbeddings({ bookIds: ['b1', 'b2'] });
    expect(before.every((c) => c.storedCardHash === null)).toBe(true);
    expect(db.getBookEmbedding('b1')).toBeNull();
    expect(db.getBookEmbedding('b2')).toBeNull();

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'noblebright', category: 'mood' }),
    });
    expect(res.status).toBe(200);

    // After: the promote's own request wired a re-embed scoped to the
    // affected books, so both now carry a stored embedding whose card_hash
    // matches their current composed card — no longer stale.
    for (const id of ['b1', 'b2']) {
      const stored = db.getBookEmbedding(id);
      expect(stored).not.toBeNull();
      const after = db.getStaleEmbeddings({ bookIds: [id] })[0]!;
      expect(after.storedCardHash).toBe(stored?.cardHash);
      expect(after.storedModel).toBe(EMBEDDING_MODEL);
    }
  });

  // Invariant: a failed re-embed must never fail or roll back the tag
  // mutation that preceded it. Simulates the embedder being unreachable.
  it('promote still succeeds and the tag mutation persists even when the re-embed fails for every book', async () => {
    const db = makeDb();
    addBook(db, { id: 'b1', title: 'Alpha' });
    db.replaceBookTags('b1', [{ tag: 'noblebright', category: 'mood', confidence: 0.8, source: 'llm-open' }], 1000);
    db.refreshProposedVocabCounts(1000);

    const alwaysFails: EmbeddingCreator = {
      create: async () => {
        throw new Error('Ollama unreachable');
      },
    };
    const app = buildApp(db, alwaysFails);

    const res = await fetch(`${await listen(app)}/api/vocab/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: 'noblebright', category: 'mood' }),
    });
    const body = (await res.json()) as {
      status: string;
      retagged: number;
      reembed: { attempted: boolean; result?: { processed: number; failed: number } };
    };

    // The promote itself is unaffected: still 200, tag still retagged.
    expect(res.status).toBe(200);
    expect(body.status).toBe('promoted');
    expect(body.retagged).toBe(1);
    expect(db.isVocabTerm('noblebright', 'mood')).toBe(true);
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: 'noblebright', source: 'vocab' });

    // The response reports the re-embed failure honestly rather than
    // implying the book is now fresh (invariant 5).
    expect(body.reembed.attempted).toBe(true);
    expect(body.reembed.result?.processed).toBe(0);
    expect(body.reembed.result?.failed).toBe(1);
    // The book is still stale — nothing was ever written for it.
    expect(db.getBookEmbedding('b1')).toBeNull();
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
    const body = (await res.json()) as {
      alias: string;
      canonical: string;
      category: string;
      retagged: number;
      reembed: { attempted: boolean };
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ alias: 'spooky', canonical, category: 'mood', retagged: 1 });
    expect(body.reembed.attempted).toBe(true);
    expect(db.getTagAlias('spooky', 'mood')).toEqual({ alias: 'spooky', canonical, category: 'mood' });
    expect(db.getTagsForBook('b1')[0]).toMatchObject({ tag: canonical, source: 'vocab' });
    expect(db.getVocabTerms(['proposed']).some((t) => t.term === 'spooky')).toBe(false);
    expect(
      db.getVocabTerms(['rejected']).some((t) => t.term === 'spooky' && t.category === 'mood')
    ).toBe(true);
    // Alias renames the tag string itself, which changes the composed card
    // text — the book goes from never-embedded to embedded, matching its
    // current (renamed) card.
    const stored = db.getBookEmbedding('b1');
    expect(stored).not.toBeNull();
    expect(stored?.model).toBe(EMBEDDING_MODEL);
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
